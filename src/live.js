// Live scoring for a multi-platform competition. Pure functions on the
// competition state so they can be unit-tested without a Durable Object.
//
// Each platform runs one group at a time. A group dives the rounds of its
// rotation that belong to that platform, diver by diver within a round, then
// moves on (the referee starts it on its next platform). A group can be on
// one platform at a time.
//
// state.live[platformId] = { groupId, current }
// state.results["diverId:round"] = { code, dd, height, platformId, scores,
//   judges, counted, dropped, sum, award, failed }
import { isValidDD, normalizeDiveCode, roundPlan } from "../public/competition-model.js";
import { lookupDD } from "../public/ddtable.js";
import { computeAward, isValidScore, slotKey } from "./scoring.js";

export class LiveError extends Error {}

const groupOf = (state, id) => state.setup.groups.find((g) => g.id === id);
const membersOf = (state, groupId) => state.setup.divers.filter((d) => d.groupId === groupId);

function diverOf(state, id) {
  const d = state.setup.divers.find((x) => x.id === id);
  if (!d) throw new LiveError("Unknown diver");
  return d;
}

function liveOf(state, platformId) {
  const l = state.live?.[platformId];
  if (!l) throw new LiveError("Unknown platform");
  return l;
}

// Makes sure every platform has a live slot and drops anything that refers
// to platforms, groups or divers that no longer exist (after a setup save).
export function cleanLive(state) {
  state.live ||= {};
  state.results ||= {};
  state.seq ||= 0;
  const { platforms, groups, divers } = state.setup;
  const live = {};
  for (const p of platforms) {
    const l = state.live[p.id] || { groupId: null, current: null };
    if (l.groupId && !groups.some((g) => g.id === l.groupId)) l.groupId = null;
    const c = l.current;
    if (c) {
      const plan = l.groupId ? roundPlan(groupOf(state, l.groupId), platforms) : [];
      const d = divers.find((x) => x.id === c.diverId);
      if (!d || d.groupId !== l.groupId || plan[c.round]?.platformId !== p.id) l.current = null;
      else if (c.phase === "scoring") {
        // Dive edited in setup while it was called: pick up the change.
        const dv = d.dives[c.round];
        if (dv && dv.code && (dv.code !== c.code || dv.dd !== c.dd)) Object.assign(c, { code: dv.code, dd: dv.dd });
      }
    }
    live[p.id] = l;
  }
  state.live = live;
  const ids = new Set(divers.map((d) => d.id));
  for (const key of Object.keys(state.results)) if (!ids.has(key.split(":")[0])) delete state.results[key];
}

// The rounds of a group that are dived on a platform.
export function roundsOn(state, groupId, platformId) {
  const g = groupOf(state, groupId);
  if (!g) return [];
  return roundPlan(g, state.setup.platforms)
    .map((slot, r) => (slot.platformId === platformId ? r : -1))
    .filter((r) => r >= 0);
}

// Every dive a group does on a platform, in diving order: round by round,
// divers in their order within each round.
export function slotsOn(state, groupId, platformId) {
  const divers = membersOf(state, groupId);
  return roundsOn(state, groupId, platformId).flatMap((round) => divers.map((d) => ({ diverId: d.id, round })));
}

export function progress(state, groupId, platformId) {
  const slots = slotsOn(state, groupId, platformId);
  return { done: slots.filter((s) => state.results[slotKey(s.diverId, s.round)]).length, total: slots.length };
}

// Next dive without a result on this platform, after the current one.
export function nextSlot(state, platformId) {
  const l = liveOf(state, platformId);
  if (!l.groupId) return null;
  const slots = slotsOn(state, l.groupId, platformId);
  const c = l.current;
  const at = c ? slots.findIndex((s) => s.diverId === c.diverId && s.round === c.round) : -1;
  for (let k = 1; k <= slots.length; k++) {
    const s = slots[(at + k) % slots.length];
    if (c && s.diverId === c.diverId && s.round === c.round) continue;
    if (!state.results[slotKey(s.diverId, s.round)]) return s;
  }
  return null;
}

// Puts a group on a platform (or takes it off with groupId null).
export function startGroup(state, platformId, groupId) {
  const l = liveOf(state, platformId);
  if (l.current?.phase === "scoring" && l.current.scores.some((v) => v !== null)) {
    throw new LiveError("A dive is being scored on this platform. Reveal or clear it first.");
  }
  if (groupId) {
    if (!groupOf(state, groupId)) throw new LiveError("Unknown group");
    if (!roundsOn(state, groupId, platformId).length) throw new LiveError("This group's rotation doesn't use this platform");
    for (const [pid, other] of Object.entries(state.live)) {
      if (pid !== platformId && other.groupId === groupId) {
        const name = state.setup.platforms.find((p) => p.id === pid)?.name;
        throw new LiveError(`${groupOf(state, groupId).name} is on ${name}. Take it off there first.`);
      }
    }
  }
  l.groupId = groupId || null;
  l.current = null;
}

export function call(state, platformId, diverId, round) {
  const l = liveOf(state, platformId);
  if (!l.groupId) throw new LiveError("Start a group on this platform first");
  const g = groupOf(state, l.groupId);
  const d = diverOf(state, diverId);
  if (d.groupId !== g.id) throw new LiveError(`${d.name} isn't in ${g.name}`);
  const slot = roundPlan(g, state.setup.platforms)[round];
  if (!slot || slot.platformId !== platformId) throw new LiveError("That dive isn't on this platform");
  const dive = d.dives[round] || { code: "", dd: 0 };
  const existing = state.results[slotKey(diverId, round)];
  l.current = {
    seq: ++state.seq,
    groupId: g.id,
    diverId,
    round,
    height: slot.height,
    code: existing?.code ?? dive.code,
    dd: existing?.dd ?? (dive.dd || lookupDD(dive.code, slot.height) || 0),
    scores: existing && existing.scores.length === g.panel ? [...existing.scores] : Array(g.panel).fill(null),
    phase: existing ? "revealed" : "scoring",
    failed: existing?.failed ?? false,
  };
}

export function callNext(state, platformId) {
  const next = nextSlot(state, platformId);
  if (!next) throw new LiveError("Every dive for this group on this platform has been scored");
  call(state, platformId, next.diverId, next.round);
}

function current(state, platformId) {
  const c = liveOf(state, platformId).current;
  if (!c) throw new LiveError("No dive is called");
  return c;
}

// Changes the dive being called. DD comes from the table for this height
// unless one is given. The diver's dive list is updated too.
export function setDive(state, platformId, code, dd) {
  const c = current(state, platformId);
  const norm = normalizeDiveCode(code);
  if (!norm) throw new LiveError("Dive number looks wrong (e.g. 105B, 5253B)");
  let value;
  let auto = false;
  if (dd === undefined || dd === null || dd === "") {
    value = lookupDD(norm, c.height);
    if (value === null) throw new LiveError(`${norm} has no DD at ${c.height}m. Enter the DD.`);
    auto = true;
  } else {
    value = Number(dd);
    if (!isValidDD(value)) throw new LiveError("DD must be a number like 2.4");
  }
  c.code = norm;
  c.dd = value;
  const d = diverOf(state, c.diverId);
  while (d.dives.length <= c.round) d.dives.push(null);
  d.dives[c.round] = { code: norm, dd: value, auto };
  if (c.phase === "revealed") reveal(state, platformId);
}

// A judge's score from a pad. Returns true if the dive was revealed.
export function judgeScore(state, platformId, seat, seq, value) {
  const c = current(state, platformId);
  if (c.seq !== seq) throw new LiveError("That dive is no longer open");
  if (c.phase !== "scoring") throw new LiveError("Scores for this dive are locked");
  if (!(seat >= 1 && seat <= c.scores.length)) throw new LiveError("Your seat isn't used for this group");
  if (!isValidScore(value)) throw new LiveError("Score must be 0–10 in half points");
  c.scores[seat - 1] = value;
  const g = groupOf(state, c.groupId);
  if (g?.autoReveal && c.scores.every((v) => v !== null) && isValidDD(c.dd)) {
    reveal(state, platformId);
    return true;
  }
  return false;
}

export function setScore(state, platformId, seat, value) {
  const c = current(state, platformId);
  if (c.phase !== "scoring") throw new LiveError("Re-open the dive to change scores");
  if (!(seat >= 1 && seat <= c.scores.length)) throw new LiveError("Invalid seat");
  if (value !== null && !isValidScore(value)) throw new LiveError("Score must be 0–10 in half points");
  c.scores[seat - 1] = value;
  c.failed = false;
}

export function revealNow(state, platformId) {
  const c = current(state, platformId);
  if (c.scores.some((v) => v === null)) throw new LiveError("Waiting for all judges");
  if (!isValidDD(c.dd)) throw new LiveError("Enter the DD first");
  reveal(state, platformId);
}

export function failDive(state, platformId) {
  const c = current(state, platformId);
  c.scores = c.scores.map(() => 0);
  c.failed = true;
  reveal(state, platformId);
}

export function reopen(state, platformId) {
  const c = current(state, platformId);
  delete state.results[slotKey(c.diverId, c.round)];
  c.phase = "scoring";
  c.failed = false;
}

export function clearCurrent(state, platformId) {
  liveOf(state, platformId).current = null;
}

function reveal(state, platformId) {
  const c = current(state, platformId);
  const { counted, dropped, sum, award } = computeAward(c.scores, isValidDD(c.dd) ? c.dd : 0);
  // Remember who was in each seat, for the score sheet.
  const judges = (state.panels?.[platformId] || []).slice(0, c.scores.length).map((id) => id || null);
  state.results[slotKey(c.diverId, c.round)] = {
    code: c.code,
    dd: c.dd,
    height: c.height,
    platformId,
    scores: [...c.scores],
    judges,
    counted,
    dropped,
    sum,
    award,
    failed: !!c.failed,
  };
  c.phase = "revealed";
}

// Totals for a group across all its platforms; equal totals share a rank.
export function groupStandings(state, groupId) {
  const g = groupOf(state, groupId);
  const rounds = g ? roundPlan(g, state.setup.platforms).length : 0;
  const rows = membersOf(state, groupId).map((d) => {
    let total = 0;
    let done = 0;
    for (let r = 0; r < rounds; r++) {
      const res = state.results[slotKey(d.id, r)];
      if (res) {
        total += res.award;
        done++;
      }
    }
    return { diverId: d.id, total: Math.round(total * 100) / 100, done, rounds };
  });
  rows.sort((a, b) => b.total - a.total);
  rows.forEach((row, i) => (row.rank = i > 0 && row.total === rows[i - 1].total ? rows[i - 1].rank : i + 1));
  return rows;
}
