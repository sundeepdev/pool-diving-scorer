import { DurableObject } from "cloudflare:workers";
import {
  JUDGE_PANELS,
  computeAward,
  diversToText,
  isValidDD,
  isValidScore,
  normalizeDiveCode,
  parseDiversText,
  slotKey,
  standings,
} from "./scoring.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_DIVERS = 100;
const MAX_ROUNDS = 12;

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

class UserError extends Error {}

// One Durable Object per meet. It owns the meet state and every live
// WebSocket (referee, judges, audience) so updates are pushed instantly.
export class Meet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) ?? null;
    });
  }

  async save() {
    await this.ctx.storage.put("state", this.state);
  }

  // ---- RPC from the Worker -------------------------------------------------

  async create(code, cfg) {
    if (this.state) return { error: "exists" };
    this.state = {
      code,
      name: "",
      event: "",
      judges: 5,
      rounds: 6,
      autoReveal: true,
      judgePin: randomString(4, "0123456789"),
      adminKey: randomString(24, "abcdefghijkmnopqrstuvwxyz23456789"),
      createdAt: Date.now(),
      divers: [],
      results: {},
      current: null,
      seq: 0,
      nextDiverId: 1,
    };
    this.applySetup(cfg);
    await this.save();
    await this.ctx.storage.setAlarm(Date.now() + RETENTION_MS);
    return { code, adminKey: this.state.adminKey, judgePin: this.state.judgePin };
  }

  async auth(role, judge, secret) {
    if (!this.state) return { ok: false, error: "Meet not found" };
    if (role === "referee") {
      return timingSafeEqual(secret, this.state.adminKey) ? { ok: true } : { ok: false, error: "Invalid referee key" };
    }
    if (role === "judge") {
      if (!timingSafeEqual(secret, this.state.judgePin)) return { ok: false, error: "Wrong judge PIN" };
      if (!(judge >= 1 && judge <= this.state.judges)) {
        return { ok: false, error: `Judge number must be 1–${this.state.judges}` };
      }
      return { ok: true };
    }
    return { ok: true };
  }

  async summary() {
    if (!this.state) return null;
    return { code: this.state.code, name: this.state.name, judges: this.state.judges };
  }

  async alarm() {
    for (const ws of this.ctx.getWebSockets()) ws.close(1001, "Meet expired");
    await this.ctx.storage.deleteAll();
    this.state = null;
  }

  // ---- WebSockets ----------------------------------------------------------

  async fetch(request) {
    if (!this.state) return new Response("Meet not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected WebSocket", { status: 426 });

    const url = new URL(request.url);
    const role = ["referee", "judge"].includes(url.searchParams.get("role")) ? url.searchParams.get("role") : "audience";
    const judge = Number(url.searchParams.get("judge")) || 0;
    const { ok, error } = await this.auth(role, judge, url.searchParams.get("key"));
    if (!ok) return new Response(error, { status: 403 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const tags = [role];
    if (role === "judge") tags.push(`judge-${judge}`);
    this.ctx.acceptWebSocket(server, tags);
    server.serializeAttachment({ role, judge });
    this.sendState(server);
    if (role === "judge") this.broadcast(["referee"]);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, message) {
    let msg;
    try {
      msg = JSON.parse(message);
    } catch {
      return;
    }
    const who = ws.deserializeAttachment() ?? {};
    try {
      if (who.role === "judge") await this.onJudgeMessage(ws, who.judge, msg);
      else if (who.role === "referee") await this.onRefereeMessage(msg);
      else return;
      await this.save();
      this.broadcast();
      if (who.role === "referee" && msg.ref !== undefined) ws.send(JSON.stringify({ type: "ack", ref: msg.ref }));
    } catch (err) {
      if (!(err instanceof UserError)) console.error(err);
      ws.send(JSON.stringify({ type: "error", message: err instanceof UserError ? err.message : "Server error", ref: msg.ref }));
    }
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 ? 1000 : code, "closing");
    } catch {}
    const who = ws.deserializeAttachment() ?? {};
    if (who.role === "judge") this.broadcast(["referee"]);
  }

  async webSocketError(ws) {
    const who = ws.deserializeAttachment() ?? {};
    if (who.role === "judge") this.broadcast(["referee"]);
  }

  // ---- Judge actions -------------------------------------------------------

  async onJudgeMessage(ws, judge, msg) {
    if (msg.type !== "score") throw new UserError("Unknown action");
    const s = this.state;
    const c = s.current;
    if (!c || c.seq !== msg.seq) throw new UserError("That dive is no longer open");
    if (c.phase !== "scoring") throw new UserError("Scores for this dive are locked");
    if (!(judge >= 1 && judge <= s.judges)) throw new UserError("Invalid judge seat");
    if (!isValidScore(msg.value)) throw new UserError("Score must be 0–10 in half points");
    c.scores[judge - 1] = msg.value;
    ws.send(JSON.stringify({ type: "ack", seq: c.seq, value: msg.value, ref: msg.ref }));
    if (s.autoReveal && c.scores.every((v) => v !== null) && isValidDD(c.dd)) this.reveal();
  }

  // ---- Referee actions -----------------------------------------------------

  async onRefereeMessage(msg) {
    const s = this.state;
    const c = s.current;
    switch (msg.type) {
      case "call":
        this.call(msg.diverId, Number(msg.round));
        break;
      case "next": {
        const next = this.nextSlot();
        if (!next) throw new UserError("Every dive has been scored");
        this.call(next.diverId, next.round);
        break;
      }
      case "setDive": {
        if (!c) throw new UserError("No dive is called");
        const code = msg.code === undefined ? c.code : msg.code === "" ? "" : normalizeDiveCode(msg.code);
        if (code === null) throw new UserError("Dive code looks wrong (e.g. 105B, 5253B)");
        const dd = msg.dd === undefined ? c.dd : Number(msg.dd);
        if (msg.dd !== undefined && !isValidDD(dd)) throw new UserError("DD must be a number like 2.4");
        c.code = code;
        c.dd = dd;
        const diver = this.diver(c.diverId);
        diver.dives[c.round] = { code, dd };
        if (c.phase === "revealed") this.reveal();
        break;
      }
      case "setScore": {
        if (!c) throw new UserError("No dive is called");
        if (c.phase !== "scoring") throw new UserError("Re-open the dive to change scores");
        const j = Number(msg.judge);
        if (!(j >= 1 && j <= s.judges)) throw new UserError("Invalid judge");
        if (msg.value !== null && !isValidScore(msg.value)) throw new UserError("Score must be 0–10 in half points");
        c.scores[j - 1] = msg.value;
        c.failed = false;
        break;
      }
      case "reveal":
        if (!c) throw new UserError("No dive is called");
        if (c.scores.some((v) => v === null)) throw new UserError("Waiting for all judges");
        if (!isValidDD(c.dd)) throw new UserError("Enter the DD first");
        this.reveal();
        break;
      case "failed":
        if (!c) throw new UserError("No dive is called");
        c.scores = c.scores.map(() => 0);
        c.failed = true;
        this.reveal();
        break;
      case "reopen":
        if (!c) throw new UserError("No dive is called");
        delete s.results[slotKey(c.diverId, c.round)];
        c.phase = "scoring";
        c.failed = false;
        break;
      case "clear":
        s.current = null;
        break;
      case "setup":
        this.applySetup(msg);
        break;
      default:
        throw new UserError("Unknown action");
    }
  }

  call(diverId, round) {
    const s = this.state;
    const diver = this.diver(diverId);
    if (!(round >= 0 && round < s.rounds)) throw new UserError("Invalid round");
    const dive = diver.dives[round] ?? { code: "", dd: 0 };
    const existing = s.results[slotKey(diverId, round)];
    s.current = {
      seq: ++s.seq,
      diverId,
      round,
      code: dive.code,
      dd: dive.dd,
      scores: existing && existing.scores.length === s.judges ? [...existing.scores] : Array(s.judges).fill(null),
      phase: existing ? "revealed" : "scoring",
      failed: existing?.failed ?? false,
    };
  }

  reveal() {
    const s = this.state;
    const c = s.current;
    const { counted, dropped, sum, award } = computeAward(c.scores, isValidDD(c.dd) ? c.dd : 0);
    s.results[slotKey(c.diverId, c.round)] = {
      code: c.code,
      dd: c.dd,
      scores: [...c.scores],
      counted,
      dropped,
      sum,
      award,
      failed: !!c.failed,
    };
    c.phase = "revealed";
  }

  diver(id) {
    const d = this.state.divers.find((x) => x.id === id);
    if (!d) throw new UserError("Unknown diver");
    return d;
  }

  // Next un-scored slot in running order (round by round), after the current one.
  nextSlot() {
    const s = this.state;
    const n = s.divers.length;
    const total = n * s.rounds;
    if (!total) return null;
    let start = 0;
    if (s.current) {
      const idx = s.divers.findIndex((d) => d.id === s.current.diverId);
      if (idx >= 0) start = s.current.round * n + idx + 1;
    }
    for (let k = 0; k < total; k++) {
      const i = (start + k) % total;
      const diver = s.divers[i % n];
      const round = Math.floor(i / n);
      if (s.current && s.current.diverId === diver.id && s.current.round === round) continue;
      if (!s.results[slotKey(diver.id, round)]) return { diverId: diver.id, round };
    }
    return null;
  }

  applySetup(cfg = {}) {
    const s = this.state;
    if (cfg.name !== undefined) s.name = String(cfg.name).trim().slice(0, 80) || "Diving Meet";
    if (cfg.autoReveal !== undefined) s.autoReveal = !!cfg.autoReveal;
    if (cfg.judges !== undefined) {
      const j = Number(cfg.judges);
      if (!JUDGE_PANELS.includes(j)) throw new UserError("Judges must be 3, 5 or 7");
      if (j !== s.judges) {
        s.judges = j;
        if (s.current) {
          s.current.scores = Array(j).fill(null);
          s.current.phase = "scoring";
          delete s.results[slotKey(s.current.diverId, s.current.round)];
        }
      }
    }
    if (cfg.event !== undefined) s.event = String(cfg.event).trim().slice(0, 60);
    if (cfg.divers !== undefined) {
      this.setDivers(cfg.divers);
    } else if (cfg.diversText !== undefined) {
      // Plain-text list (API / older clients): keep ids for divers whose name is unchanged.
      const byName = new Map(s.divers.map((d) => [d.name.toLowerCase(), d.id]));
      this.setDivers(parseDiversText(cfg.diversText).map((p) => ({ ...p, id: byName.get(p.name.toLowerCase()) })));
    }
    if (cfg.rounds !== undefined) {
      const r = Math.round(Number(cfg.rounds));
      if (!(r >= 1 && r <= MAX_ROUNDS)) throw new UserError(`Rounds must be 1–${MAX_ROUNDS}`);
      s.rounds = r;
    } else if (cfg.diversText !== undefined && s.divers.length) {
      s.rounds = Math.min(MAX_ROUNDS, Math.max(s.rounds, ...s.divers.map((d) => d.dives.length)));
    }
    if (s.current && s.current.round >= s.rounds) s.current = null;
    if (s.current) {
      const dive = this.diver(s.current.diverId).dives[s.current.round];
      if (dive && s.current.phase === "scoring") Object.assign(s.current, { code: dive.code, dd: dive.dd });
    }
  }

  // Replaces the diver list. Divers keep their id (and so their results) when
  // the client sends it back; anything without a known id is a new diver.
  setDivers(list) {
    const s = this.state;
    if (!Array.isArray(list)) throw new UserError("Diver list is missing");
    if (list.length > MAX_DIVERS) throw new UserError(`At most ${MAX_DIVERS} divers`);
    const known = new Set(s.divers.map((d) => d.id));
    const used = new Set();
    s.divers = list.map((p, i) => {
      const name = String(p?.name ?? "").trim().slice(0, 60);
      if (!name) throw new UserError(`Diver #${i + 1} needs a name`);
      const team = String(p.team ?? "").trim().slice(0, 40);
      const dives = (Array.isArray(p.dives) ? p.dives : []).slice(0, MAX_ROUNDS).map((d, r) => {
        if (!d || (!d.code && !Number(d.dd))) return null;
        const code = d.code ? normalizeDiveCode(d.code) : "";
        if (code === null) throw new UserError(`${name}, round ${r + 1}: "${d.code}" is not a dive number (e.g. 105B)`);
        const dd = Number(d.dd) || 0;
        if (dd && !isValidDD(dd)) throw new UserError(`${name}, round ${r + 1}: DD must be a number like 2.4`);
        return { code, dd };
      });
      while (dives.length && !dives[dives.length - 1]) dives.pop();
      const id = typeof p.id === "string" && known.has(p.id) && !used.has(p.id) ? p.id : `d${s.nextDiverId++}`;
      used.add(id);
      return { id, name, team, dives };
    });
    for (const key of Object.keys(s.results)) if (!used.has(key.split(":")[0])) delete s.results[key];
    if (s.current && !used.has(s.current.diverId)) s.current = null;
  }

  // ---- Views ---------------------------------------------------------------

  publicView() {
    const s = this.state;
    const c = s.current;
    return {
      code: s.code,
      name: s.name,
      event: s.event ?? "",
      judges: s.judges,
      rounds: s.rounds,
      autoReveal: s.autoReveal,
      divers: s.divers,
      results: s.results,
      standings: standings(s.divers, s.results, s.rounds),
      next: this.nextSlot(),
      current: c && {
        seq: c.seq,
        diverId: c.diverId,
        round: c.round,
        code: c.code,
        dd: c.dd,
        phase: c.phase,
        submitted: c.scores.map((v) => v !== null),
        // Individual scores stay hidden until the referee/auto-reveal locks the dive.
        scores: c.phase === "revealed" ? c.scores : null,
      },
    };
  }

  connectedJudges() {
    const seats = new Set();
    for (const ws of this.ctx.getWebSockets("judge")) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = ws.deserializeAttachment();
      if (a?.judge) seats.add(a.judge);
    }
    return [...seats].sort((a, b) => a - b);
  }

  viewFor(role, judge, pub) {
    const s = this.state;
    if (role === "referee") {
      return {
        ...pub,
        judgePin: s.judgePin,
        diversText: diversToText(s.divers),
        connectedJudges: this.connectedJudges(),
        current: pub.current && { ...pub.current, scores: s.current.scores },
      };
    }
    if (role === "judge") {
      return { ...pub, me: judge, myScore: s.current ? s.current.scores[judge - 1] ?? null : null };
    }
    return pub;
  }

  sendState(ws, pub = this.publicView()) {
    const { role, judge } = ws.deserializeAttachment() ?? {};
    try {
      ws.send(JSON.stringify({ type: "state", state: this.viewFor(role, judge, pub) }));
    } catch {}
  }

  broadcast(roles) {
    if (!this.state) return;
    const pub = this.publicView();
    const sockets = roles ? roles.flatMap((r) => this.ctx.getWebSockets(r)) : this.ctx.getWebSockets();
    for (const ws of sockets) this.sendState(ws, pub);
  }
}
