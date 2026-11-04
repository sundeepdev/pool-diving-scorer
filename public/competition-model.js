// Pure setup logic for a multi-platform competition, shared by the Durable
// Object and the tests.
//
// A competition has platforms (a board or platform at a height), a list of
// judges, groups of divers, and divers. Each group dives a rotation of legs,
// for example 3 dives on the 1m board and then 3 dives on the 3m board, so
// the height of a diver's dive depends on the round. DD comes from the World
// Aquatics table for that height unless the referee typed it by hand.
//
// Served to the browser too (the setup page validates as you type), so it only
// imports other files from public/.
import { HEIGHTS, lookupDD } from "./ddtable.js";

export const JUDGE_PANELS = [3, 5, 7];
const CODE_RE = /^\d{3,4}[A-D]$/i;
export const normalizeDiveCode = (code) => {
  const c = String(code ?? "").trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
};
export const isValidDD = (dd) => typeof dd === "number" && Number.isFinite(dd) && dd > 0 && dd <= 5;

export const LIMITS = { platforms: 8, judges: 60, groups: 30, divers: 300, legs: 6, rounds: 12, extra: 20 };

const ID_RE = /^[a-z][a-z0-9_-]{1,23}$/i;

export class SetupError extends Error {}

const text = (v, max) => String(v ?? "").trim().slice(0, max);

function ids(list, what) {
  const seen = new Set();
  for (const item of list) {
    if (!ID_RE.test(String(item?.id ?? ""))) throw new SetupError(`${what} has an invalid id`);
    if (seen.has(item.id)) throw new SetupError(`${what} id "${item.id}" is used twice`);
    seen.add(item.id);
  }
  return seen;
}

function arr(v, max, what) {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v)) throw new SetupError(`${what} must be a list`);
  if (v.length > max) throw new SetupError(`At most ${max} ${what}`);
  return v;
}

// Height of each round for a group: [{ platformId, height }] in diving order.
export function roundPlan(group, platforms) {
  const byId = new Map(platforms.map((p) => [p.id, p]));
  const plan = [];
  for (const leg of group.legs) {
    const p = byId.get(leg.platformId);
    for (let i = 0; i < leg.dives; i++) plan.push({ platformId: leg.platformId, height: p ? p.height : null });
  }
  return plan;
}

// Validates and cleans a whole setup sent by a referee. Throws SetupError
// with a message the referee can act on.
export function normalizeSetup(input) {
  if (!input || typeof input !== "object") throw new SetupError("Setup is missing");
  const name = text(input.name, 80) || "Diving Competition";

  const platforms = arr(input.platforms, LIMITS.platforms, "platforms").map((p, i) => {
    const height = String(p?.height ?? "");
    if (!HEIGHTS.includes(height)) throw new SetupError(`Platform ${i + 1}: height must be one of ${HEIGHTS.join(", ")} m`);
    return { id: p.id, name: text(p.name, 40) || `${height}m`, height };
  });
  const platformIds = ids(platforms, "Platform");

  const judges = arr(input.judges, LIMITS.judges, "judges").map((j, i) => {
    const jn = text(j?.name, 60);
    if (!jn) throw new SetupError(`Judge ${i + 1} needs a name`);
    return { id: j.id, name: jn };
  });
  ids(judges, "Judge");

  const groups = arr(input.groups, LIMITS.groups, "groups").map((g, i) => {
    const gname = text(g?.name, 60);
    if (!gname) throw new SetupError(`Group ${i + 1} needs a name`);
    const panel = Number(g.panel ?? 5);
    if (!JUDGE_PANELS.includes(panel)) throw new SetupError(`${gname}: judges per panel must be 3, 5 or 7`);
    let total = 0;
    const legs = arr(g.legs, LIMITS.legs, `legs in ${gname}`).map((leg) => {
      if (!platformIds.has(leg?.platformId)) throw new SetupError(`${gname}: rotation uses a platform that doesn't exist`);
      const dives = Math.round(Number(leg.dives));
      if (!(dives >= 1 && dives <= LIMITS.rounds)) throw new SetupError(`${gname}: each leg needs 1–${LIMITS.rounds} dives`);
      total += dives;
      return { platformId: leg.platformId, dives };
    });
    if (total > LIMITS.rounds) throw new SetupError(`${gname}: at most ${LIMITS.rounds} dives in total`);
    return { id: g.id, name: gname, panel, autoReveal: g.autoReveal === undefined ? true : !!g.autoReveal, legs };
  });
  const groupIds = ids(groups, "Group");
  const plans = new Map(groups.map((g) => [g.id, roundPlan(g, platforms)]));

  const divers = arr(input.divers, LIMITS.divers, "divers").map((d, i) => {
    const dname = text(d?.name, 60);
    if (!dname) throw new SetupError(`Diver ${i + 1} needs a name`);
    const groupId = d.groupId ? String(d.groupId) : null;
    if (groupId && !groupIds.has(groupId)) throw new SetupError(`${dname}: unknown group`);
    const plan = groupId ? plans.get(groupId) : [];
    const dives = arr(d.dives, LIMITS.rounds, `dives for ${dname}`).map((dv, r) => {
      if (!dv || (!dv.code && !Number(dv.dd))) return null;
      const code = dv.code ? normalizeDiveCode(dv.code) : "";
      if (code === null) throw new SetupError(`${dname}, dive ${r + 1}: "${dv.code}" is not a dive number (e.g. 105B)`);
      const height = plan[r]?.height ?? null;
      const tableDD = code && height ? lookupDD(code, height) : null;
      let dd = Number(dv.dd) || 0;
      let auto = false;
      if (!dd || (dv.auto && tableDD)) {
        // Empty DD, or a DD that was filled in automatically: take the table value
        // for this round's height (it changes if the rotation changes).
        dd = tableDD ?? 0;
        auto = tableDD !== null;
      }
      if (dd && !isValidDD(dd)) throw new SetupError(`${dname}, dive ${r + 1}: DD must be a number like 2.4`);
      return { code, dd, auto };
    });
    while (dives.length && !dives[dives.length - 1]) dives.pop();
    const extra = [];
    for (const c of arr(d.extra, LIMITS.extra, `other dives for ${dname}`)) {
      const code = normalizeDiveCode(c);
      if (code === null) throw new SetupError(`${dname}: "${c}" in other dives is not a dive number`);
      if (!extra.includes(code)) extra.push(code);
    }
    return { id: d.id, name: dname, team: text(d.team, 40), groupId, dives, extra };
  });
  ids(divers, "Diver");

  return { name, platforms, judges, groups, divers };
}

// Problems that don't block saving but that the referee should fix before
// the competition starts. Returns [{ diverId?, groupId?, round?, message }].
export function setupWarnings(setup) {
  const out = [];
  if (!setup.platforms.length) out.push({ message: "Add at least one platform or board" });
  if (!setup.judges.length) out.push({ message: "Add the judges" });
  for (const g of setup.groups) {
    const plan = roundPlan(g, setup.platforms);
    if (!plan.length) out.push({ groupId: g.id, message: `${g.name}: set the rotation (which platform, how many dives)` });
    const members = setup.divers.filter((d) => d.groupId === g.id);
    if (!members.length) out.push({ groupId: g.id, message: `${g.name}: no divers` });
    for (const d of members) {
      if (plan.length && d.dives.length > plan.length) out.push({ groupId: g.id, diverId: d.id, message: `${d.name} has ${d.dives.length} dives but ${g.name} has ${plan.length} in its rotation` });
      plan.forEach((slot, r) => {
        const dv = d.dives[r];
        if (!dv || !dv.code) out.push({ groupId: g.id, diverId: d.id, round: r, message: `${d.name}: dive ${r + 1} is missing` });
        else if (!dv.dd) out.push({ groupId: g.id, diverId: d.id, round: r, message: `${d.name}: ${dv.code} has no DD at ${slot.height}m, enter it by hand` });
      });
    }
  }
  const unassigned = setup.divers.filter((d) => !d.groupId).length;
  if (unassigned) out.push({ message: `${unassigned} diver(s) are not in a group` });
  return out;
}

// ---- Judge panels ----------------------------------------------------------
//
// Each platform has seats 1–7. A judge sits in at most one seat at a time, so
// moving a judge to another platform frees their old seat. Only the first
// `panelSize` seats of a platform are used: the largest panel (3, 5 or 7) of
// the groups whose rotation includes that platform.

export const MAX_SEATS = 7;

export function panelSize(setup, platformId) {
  const sizes = setup.groups.filter((g) => g.legs.some((l) => l.platformId === platformId)).map((g) => g.panel);
  return sizes.length ? Math.max(...sizes) : 5;
}

// Drops platforms and judges that no longer exist and makes sure every
// platform has MAX_SEATS seats and no judge sits twice.
export function cleanPanels(panels, setup) {
  const judges = new Set(setup.judges.map((j) => j.id));
  const seen = new Set();
  const out = {};
  for (const p of setup.platforms) {
    out[p.id] = Array.from({ length: MAX_SEATS }, (_, i) => {
      const id = panels?.[p.id]?.[i] ?? null;
      if (!id || !judges.has(id) || seen.has(id)) return null;
      seen.add(id);
      return id;
    });
  }
  return out;
}

// Puts a judge in a seat (1-based), or empties it when judgeId is null.
export function assignSeat(panels, setup, platformId, seat, judgeId) {
  if (!setup.platforms.some((p) => p.id === platformId)) throw new SetupError("Unknown platform");
  if (!(Number.isInteger(seat) && seat >= 1 && seat <= MAX_SEATS)) throw new SetupError(`Seat must be 1–${MAX_SEATS}`);
  if (judgeId !== null && !setup.judges.some((j) => j.id === judgeId)) throw new SetupError("Unknown judge");
  const out = cleanPanels(panels, setup);
  if (judgeId) for (const seats of Object.values(out)) seats.forEach((id, i) => id === judgeId && (seats[i] = null));
  out[platformId][seat - 1] = judgeId;
  return out;
}

// Fills the empty seats in use with judges who aren't on any panel yet, in
// the order of the judge list and the platform list.
export function fillPanels(panels, setup) {
  const out = cleanPanels(panels, setup);
  const seated = new Set(Object.values(out).flat().filter(Boolean));
  const free = setup.judges.map((j) => j.id).filter((id) => !seated.has(id));
  for (const p of setup.platforms) {
    const n = panelSize(setup, p.id);
    for (let i = 0; i < n && free.length; i++) if (!out[p.id][i]) out[p.id][i] = free.shift();
  }
  return out;
}

// Where a judge sits: { platformId, seat, active } or null.
export function judgeSeat(panels, setup, judgeId) {
  for (const p of setup.platforms) {
    const i = (panels?.[p.id] ?? []).indexOf(judgeId);
    if (i >= 0) return { platformId: p.id, seat: i + 1, active: i < panelSize(setup, p.id) };
  }
  return null;
}
