import { DurableObject } from "cloudflare:workers";
import { SetupError, normalizeSetup, setupWarnings } from "../public/competition-model.js";

const RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

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
// groups of divers and each diver's dives. Live scoring per platform is added
// in a later phase; this object already serialises every change so two
// referees editing at once can't overwrite each other (see `version`).
export class Competition extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      this.state = (await ctx.storage.get("state")) ?? null;
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
    this.state.version++;
    await this.ctx.storage.put("state", this.state);
    return { status: 200, body: this.view() };
  }

  view() {
    const { code, version, judgePin, setup } = this.state;
    return { code, version, judgePin, setup, warnings: setupWarnings(setup) };
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
    this.state = null;
  }
}
