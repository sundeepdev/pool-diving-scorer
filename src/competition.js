import { DurableObject } from "cloudflare:workers";
import { SetupError, assignSeat, cleanPanels, fillPanels, judgeSeat, normalizeSetup, panelSize, roundPlan, setupWarnings } from "../public/competition-model.js";
import * as live from "./live.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Wrong judge PINs allowed per minute before judge sign-in pauses.
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
//   referee: { type: "hello", role: "referee", key }  (head referee key, or a
//            platform referee key that only controls that platform)
//   judge:   { type: "hello", role: "judge", pin, judgeId? }
//   scoreboard: { type: "hello", role: "audience" }
// A judge without judgeId gets the judge list to pick their name from.
export class Competition extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.failures = [];
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) ?? null;
      // Competitions created before judge panels or live scoring existed.
      if (this.state) this.tidy();
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
    this.tidy();
    await this.ctx.storage.put("state", this.state);
    await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
    return { code, adminKey: this.state.adminKey };
  }

  // Keeps panels, live state and platform referee keys consistent with the setup.
  tidy() {
    const st = this.state;
    st.panels = cleanPanels(st.panels, st.setup);
    live.cleanLive(st);
    st.platformKeys ||= {};
    const keys = {};
    for (const p of st.setup.platforms) keys[p.id] = st.platformKeys[p.id] || randomString(24, "abcdefghijkmnopqrstuvwxyz23456789");
    st.platformKeys = keys;
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
    this.tidy();
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
      if (who.role === "judge") await this.onJudge(ws, who.judgeId, msg);
      else if (who.role === "referee") this.onReferee(who.scope, msg);
      else throw new SetupError("Sign in first");
      await this.ctx.storage.put("state", this.state);
      this.broadcast();
      if (msg.ref !== undefined) ws.send(JSON.stringify({ type: "ack", ref: msg.ref, seq: msg.seq, value: msg.value }));
    } catch (err) {
      const known = err instanceof SetupError || err instanceof live.LiveError;
      if (!known) console.error(err);
      ws.send(JSON.stringify({ type: "error", message: known ? err.message : "Server error", ref: msg.ref }));
    }
  }

  onReferee(scope, msg) {
    const st = this.state;
    const { setup } = st;
    const head = scope === "all";
    // Panels: head referee only.
    if (["seat", "fill", "clearPanels"].includes(msg.type)) {
      if (!head) throw new SetupError("Only the head referee can change judge panels");
      if (msg.type === "seat") st.panels = assignSeat(st.panels, setup, String(msg.platformId), Number(msg.seat), msg.judgeId ? String(msg.judgeId) : null);
      else if (msg.type === "fill") st.panels = fillPanels(st.panels, setup);
      else st.panels = cleanPanels({}, setup);
      return;
    }
    const pid = String(msg.platformId ?? "");
    if (!head && pid !== scope) throw new SetupError("You control a different platform");
    switch (msg.type) {
      case "startGroup":
        return live.startGroup(st, pid, msg.groupId ? String(msg.groupId) : null);
      case "call":
        return live.call(st, pid, String(msg.diverId), Number(msg.round));
      case "next":
        return live.callNext(st, pid);
      case "setDive":
        live.setDive(st, pid, msg.code, msg.dd);
        st.version++; // the diver's dive list changed: a stale setup page must reload
        return;
      case "setScore":
        return live.setScore(st, pid, Number(msg.seat), msg.value === null ? null : Number(msg.value));
      case "reveal":
        return live.revealNow(st, pid);
      case "failed":
        return live.failDive(st, pid);
      case "reopen":
        return live.reopen(st, pid);
      case "clear":
        return live.clearCurrent(st, pid);
      default:
        throw new SetupError("Unknown action");
    }
  }

  async onJudge(ws, judgeId, msg) {
    const st = this.state;
    const at = judgeSeat(st.panels, st.setup, judgeId);
    if (!at) throw new SetupError("You're not on a panel");
    if (msg.type === "score") return live.judgeScore(st, at.platformId, at.seat, Number(msg.seq), Number(msg.value));
    if (msg.type === "setDive") {
      // The judge in seat 1 (chief judge) may correct the dive before it's revealed.
      if (at.seat !== 1) throw new SetupError("Only the judge in seat 1 can change the dive");
      if (st.live[at.platformId]?.current?.phase !== "scoring") throw new SetupError("The dive is already revealed");
      live.setDive(st, at.platformId, msg.code, msg.dd);
      st.version++;
      return;
    }
    throw new SetupError("Unknown action");
  }

  hello(ws, msg) {
    const fail = (message) => {
      this.failures.push(Date.now());
      ws.send(JSON.stringify({ type: "error", fatal: true, message }));
    };
    if (msg.role === "referee") {
      // Referee keys are 24 random characters, so they aren't throttled: a flood of
      // wrong judge PINs must never lock the referee out.
      let scope = null;
      if (timingSafeEqual(msg.key, this.state.adminKey)) scope = "all";
      else for (const [pid, k] of Object.entries(this.state.platformKeys)) if (timingSafeEqual(msg.key, k)) scope = pid;
      if (!scope) return ws.send(JSON.stringify({ type: "error", fatal: true, message: "Invalid referee key" }));
      ws.serializeAttachment({ role: "referee", scope });
      return this.sendState(ws);
    }
    if (msg.role === "judge") {
      if (this.throttled()) return ws.send(JSON.stringify({ type: "error", fatal: true, message: "Too many attempts. Wait a minute and try again." }));
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
    if (msg.role === "audience") {
      // Scoreboards need no sign-in and only get public information.
      ws.serializeAttachment({ role: "audience" });
      return this.sendState(ws);
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

  refereeView(scope) {
    const st = this.state;
    const { code, judgePin, setup, panels } = st;
    const progress = {};
    for (const p of setup.platforms) {
      progress[p.id] = {};
      for (const g of setup.groups) if (live.roundsOn(st, g.id, p.id).length) progress[p.id][g.id] = live.progress(st, g.id, p.id);
    }
    return {
      code,
      scope,
      judgePin,
      name: setup.name,
      platforms: setup.platforms,
      judges: setup.judges,
      groups: setup.groups.map((g) => ({ ...g, plan: roundPlan(g, setup.platforms) })),
      divers: setup.divers,
      panels,
      sizes: Object.fromEntries(setup.platforms.map((p) => [p.id, panelSize(setup, p.id)])),
      online: this.onlineJudges(),
      live: st.live,
      next: Object.fromEntries(setup.platforms.map((p) => [p.id, live.nextSlot(st, p.id)])),
      progress,
      results: st.results,
      standings: Object.fromEntries(setup.groups.map((g) => [g.id, live.groupStandings(st, g.id)])),
      // Only the head referee can hand out platform referee links.
      platformKeys: scope === "all" ? st.platformKeys : undefined,
    };
  }

  judgeView(judgeId) {
    const { code, setup, panels } = this.state;
    const me = setup.judges.find((j) => j.id === judgeId);
    if (!me) return { code, name: setup.name, me: null, seat: null };
    const at = judgeSeat(panels, setup, judgeId);
    const platform = at && setup.platforms.find((p) => p.id === at.platformId);
    const l = at ? this.state.live[at.platformId] : null;
    const group = l?.groupId ? setup.groups.find((g) => g.id === l.groupId) : null;
    const c = l?.current;
    const diver = c ? setup.divers.find((d) => d.id === c.diverId) : null;
    const res = c ? this.state.results[`${c.diverId}:${c.round}`] : null;
    const next = at ? live.nextSlot(this.state, at.platformId) : null;
    const nextDiver = next && setup.divers.find((d) => d.id === next.diverId);
    return {
      code,
      name: setup.name,
      me,
      seat: at && {
        ...at,
        platformName: platform.name,
        height: platform.height,
        size: panelSize(setup, platform.id),
        groups: setup.groups.filter((g) => g.legs.some((leg) => leg.platformId === platform.id)).map((g) => g.name),
      },
      group: group && { id: group.id, name: group.name, panel: group.panel, rounds: roundPlan(group, setup.platforms).length },
      // Seats beyond the group's panel size don't score.
      scoring: !!(at && group && at.seat <= group.panel),
      canEditDive: at?.seat === 1,
      current: c && {
        seq: c.seq,
        diverName: diver?.name ?? "",
        team: diver?.team ?? "",
        round: c.round,
        code: c.code,
        dd: c.dd,
        height: c.height,
        phase: c.phase,
        failed: c.failed,
        submitted: c.scores.filter((v) => v !== null).length,
        panel: c.scores.length,
        myScore: at && at.seat <= c.scores.length ? c.scores[at.seat - 1] : null,
        // Other judges' scores stay hidden until the dive is revealed.
        scores: c.phase === "revealed" ? c.scores : null,
        dropped: res?.dropped ?? [],
        award: res?.award ?? null,
        // Dives this diver declared or can also do, for the chief judge's dive picker.
        options: diver ? [...new Set([...diver.dives.filter(Boolean).map((d) => d.code), ...(diver.extra || [])].filter(Boolean))] : [],
      },
      next: nextDiver ? { diverName: nextDiver.name, round: next.round } : null,
    };
  }

  // What a public scoreboard may see: no PINs, keys or judge names, and
  // individual scores only once a dive is revealed.
  audienceView() {
    const st = this.state;
    const { setup } = st;
    const results = {};
    for (const [k, r] of Object.entries(st.results)) {
      results[k] = { code: r.code, dd: r.dd, height: r.height, platformId: r.platformId, scores: r.scores, dropped: r.dropped, award: r.award, failed: r.failed };
    }
    return {
      code: st.code,
      name: setup.name,
      divers: setup.divers.map(({ id, name, team, groupId }) => ({ id, name, team, groupId })),
      groups: setup.groups.map((g) => ({ id: g.id, name: g.name, plan: roundPlan(g, setup.platforms) })),
      platforms: setup.platforms.map((p) => {
        const l = st.live[p.id] || {};
        const c = l.current;
        return {
          id: p.id,
          name: p.name,
          height: p.height,
          groupId: l.groupId || null,
          progress: l.groupId ? live.progress(st, l.groupId, p.id) : null,
          next: live.nextSlot(st, p.id),
          current: c && {
            seq: c.seq,
            diverId: c.diverId,
            round: c.round,
            code: c.code,
            dd: c.dd,
            height: c.height,
            phase: c.phase,
            failed: c.failed,
            submitted: c.scores.map((v) => v !== null),
            scores: c.phase === "revealed" ? c.scores : null,
          },
        };
      }),
      results,
      standings: Object.fromEntries(setup.groups.map((g) => [g.id, live.groupStandings(st, g.id)])),
    };
  }

  sendState(ws) {
    const who = ws.deserializeAttachment() ?? {};
    let state;
    if (who.role === "referee") state = this.refereeView(who.scope || "all");
    else if (who.role === "judge") state = this.judgeView(who.judgeId);
    else if (who.role === "audience") state = this.audienceView();
    else return;
    try {
      ws.send(JSON.stringify({ type: "state", state }));
    } catch {}
  }

  broadcast(roles = ["referee", "judge", "audience"]) {
    if (!this.state) return;
    for (const role of roles) for (const ws of this.sockets(role)) this.sendState(ws);
  }
}
