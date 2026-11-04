import { DurableObject } from "cloudflare:workers";
import { SetupError, assignSeat, cleanPanels, fillPanels, judgeSeat, normalizeSetup, panelSize, setupWarnings } from "../public/competition-model.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Wrong PINs or referee keys allowed per minute before sign-in pauses.
const MAX_FAILURES = 10;

function randomString(len, alphabet) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
}

function timingSafeEqual(a, b) {
  a = String(a ?? "");
  b = String(b ?? "");
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// One Durable Object per multi-platform competition: platforms, judges,
// groups of divers, each diver's dives, and which judge sits where. It owns
// every live connection (referees and judges) and pushes changes to them.
// Setup saves carry a `version` so two referees can't overwrite each other.
//
// WebSocket sign-in happens in the first message, never in the URL, so PINs
// and keys don't end up in request logs:
//   referee: { type: "hello", role: "referee", key }
//   judge:   { type: "hello", role: "judge", pin, judgeId? }
// A judge without judgeId gets the judge list to pick their name from.
export class Competition extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.failures = [];
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) ?? null;
      // Competitions created before judge panels existed.
      if (this.state && !this.state.panels) this.state.panels = cleanPanels({}, this.state.setup);
    });
  }

  async create(code, input) {
    if (this.state) return { error: "exists" };
    const setup = normalizeSetup({ name: input?.name });
    this.state = {
      code,
      createdAt: Date.now(),
      adminKey: randomString(24, "abcdefghijkmnopqrstuvwxyz23456789"),
      judgePin: randomString(4, "0123456789"),
      version: 1,
      setup,
      panels: cleanPanels({}, setup),
    };
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
    return { code, adminKey: this.state.adminKey };
  }

  async exists() {
    return !!this.state;
  }

  async summary() {
    if (!this.state) return null;
    const { setup } = this.state;
    return {
      code: this.state.code,
      kind: "competition",
      name: setup.name,
      platforms: setup.platforms,
      groups: setup.groups.map((g) => ({ id: g.id, name: g.name })),
    };
  }

  // Full setup for a referee. Returns { status, body }.
  async getSetup(key) {
    if (!this.state) return { status: 404, body: { error: "Competition not found" } };
    if (!timingSafeEqual(key, this.state.adminKey)) return { status: 403, body: { error: "Invalid referee key" } };
    return { status: 200, body: this.view() };
  }

  async putSetup(key, input) {
    if (!this.state) return { status: 404, body: { error: "Competition not found" } };
    if (!timingSafeEqual(key, this.state.adminKey)) return { status: 403, body: { error: "Invalid referee key" } };
    if (Number(input?.version) !== this.state.version) {
      return { status: 409, body: { error: "Someone else saved changes. Reload to see them before saving again.", ...this.view() } };
    }
    let setup;
    try {
      setup = normalizeSetup(input.setup);
    } catch (err) {
      if (err instanceof SetupError) return { status: 400, body: { error: err.message } };
      throw err;
    }
    this.state.setup = setup;
    this.state.panels = cleanPanels(this.state.panels, setup);
    this.state.version++;
    await this.ctx.storage.put("state", this.state);
    this.broadcast();
    return { status: 200, body: this.view() };
  }

  view() {
    const { code, version, judgePin, setup } = this.state;
    return { code, version, judgePin, setup, warnings: setupWarnings(setup) };
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, "Competition expired");
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  // ---- WebSockets ----------------------------------------------------------

  async fetch(request) {
    if (!this.state) return new Response("Competition not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ role: null });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Too many wrong PINs or keys in the last minute (4-digit PINs are guessable).
  throttled() {
    const now = Date.now();
    this.failures = this.failures.filter((t) => now - t < 60_000);
    return this.failures.length >= MAX_FAILURES;
  }

  async webSocketMessage(ws, message) {
    if (!this.state) return;
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const who = ws.deserializeAttachment() ?? {};
    try {
      if (msg.type === "hello") return this.hello(ws, msg);
      if (who.role !== "referee") throw new SetupError(who.role ? "Only the referee can do that" : "Sign in first");
      const { setup } = this.state;
      if (msg.type === "seat") {
        this.state.panels = assignSeat(this.state.panels, setup, String(msg.platformId), Number(msg.seat), msg.judgeId ? String(msg.judgeId) : null);
      } else if (msg.type === "fill") {
        this.state.panels = fillPanels(this.state.panels, setup);
      } else if (msg.type === "clearPanels") {
        this.state.panels = cleanPanels({}, setup);
      } else throw new SetupError("Unknown action");
      await this.ctx.storage.put("state", this.state);
      this.broadcast();
      if (msg.ref !== undefined) ws.send(JSON.stringify({ type: "ack", ref: msg.ref }));
    } catch (err) {
      if (!(err instanceof SetupError)) console.error(err);
      ws.send(JSON.stringify({ type: "error", message: err instanceof SetupError ? err.message : "Server error", ref: msg.ref }));
    }
  }

  hello(ws, msg) {
    const fail = (message) => {
      this.failures.push(Date.now());
      ws.send(JSON.stringify({ type: "error", fatal: true, message }));
    };
    if (this.throttled()) return ws.send(JSON.stringify({ type: "error", fatal: true, message: "Too many attempts. Wait a minute and try again." }));
    if (msg.role === "referee") {
      if (!timingSafeEqual(msg.key, this.state.adminKey)) return fail("Invalid referee key");
      ws.serializeAttachment({ role: "referee" });
      return this.sendState(ws);
    }
    if (msg.role === "judge") {
      if (!timingSafeEqual(msg.pin, this.state.judgePin)) return fail("Wrong judge PIN");
      const judge = this.state.setup.judges.find((j) => j.id === msg.judgeId);
      if (!judge) {
        const was = ws.deserializeAttachment()?.role;
        ws.serializeAttachment({ role: null });
        ws.send(JSON.stringify({ type: "chooseJudge", name: this.state.setup.name, judges: this.state.setup.judges }));
        if (was === "judge") this.broadcast(["referee"]);
        return;
      }
      // One device per judge: the newest sign-in wins.
      for (const other of this.sockets("judge")) {
        if (other !== ws && other.deserializeAttachment()?.judgeId === judge.id) {
          try {
            other.send(JSON.stringify({ type: "replaced" }));
            other.close(4000, "Signed in on another device");
          } catch {}
        }
      }
      ws.serializeAttachment({ role: "judge", judgeId: judge.id });
      this.sendState(ws);
      return this.broadcast(["referee"]);
    }
    ws.send(JSON.stringify({ type: "error", fatal: true, message: "Unknown role" }));
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {}
    if (ws.deserializeAttachment()?.role === "judge") this.broadcast(["referee"]);
  }

  async webSocketError(ws) {
    if (ws.deserializeAttachment()?.role === "judge") this.broadcast(["referee"]);
  }

  sockets(role) {
    return this.ctx.getWebSockets().filter((ws) => ws.readyState === WebSocket.OPEN && ws.deserializeAttachment()?.role === role);
  }

  onlineJudges() {
    return [...new Set(this.sockets("judge").map((ws) => ws.deserializeAttachment().judgeId))];
  }

  refereeView() {
    const { code, judgePin, setup, panels } = this.state;
    return {
      code,
      judgePin,
      name: setup.name,
      platforms: setup.platforms,
      judges: setup.judges,
      groups: setup.groups.map(({ id, name, panel, legs }) => ({ id, name, panel, legs })),
      panels,
      sizes: Object.fromEntries(setup.platforms.map((p) => [p.id, panelSize(setup, p.id)])),
      online: this.onlineJudges(),
    };
  }

  judgeView(judgeId) {
    const { code, setup, panels } = this.state;
    const me = setup.judges.find((j) => j.id === judgeId);
    if (!me) return { code, name: setup.name, me: null, seat: null };
    const at = judgeSeat(panels, setup, judgeId);
    const platform = at && setup.platforms.find((p) => p.id === at.platformId);
    return {
      code,
      name: setup.name,
      me,
      seat: at && {
        ...at,
        platformName: platform.name,
        height: platform.height,
        size: panelSize(setup, platform.id),
        groups: setup.groups.filter((g) => g.legs.some((l) => l.platformId === platform.id)).map((g) => g.name),
      },
    };
  }

  sendState(ws) {
    const who = ws.deserializeAttachment() ?? {};
    let state;
    if (who.role === "referee") state = this.refereeView();
    else if (who.role === "judge") state = this.judgeView(who.judgeId);
    else return;
    try {
      ws.send(JSON.stringify({ type: "state", state }));
    } catch {}
  }

  broadcast(roles = ["referee", "judge"]) {
    if (!this.state) return;
    for (const role of roles) for (const ws of this.sockets(role)) this.sendState(ws);
  }
}
