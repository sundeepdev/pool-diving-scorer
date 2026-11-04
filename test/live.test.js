import { test } from "node:test";
import assert from "node:assert/strict";
import { cleanPanels, normalizeSetup } from "../public/competition-model.js";
import {
  LiveError,
  call,
  callNext,
  cleanLive,
  failDive,
  groupStandings,
  judgeScore,
  nextSlot,
  progress,
  reopen,
  revealNow,
  setDive,
  setScore,
  slotsOn,
  startGroup,
} from "../src/live.js";

// Girls (3 judges) dive 2 rounds on 1m then 2 on 3m; Boys (5 judges) 2 on 3m.
function fixture() {
  const setup = normalizeSetup({
    name: "Champs",
    platforms: [
      { id: "p1", name: "1m", height: "1" },
      { id: "p3", name: "3m", height: "3" },
    ],
    judges: ["a", "b", "c", "d", "e"].map((n) => ({ id: `j${n}`, name: n.toUpperCase() })),
    groups: [
      { id: "g1", name: "Girls", panel: 3, legs: [{ platformId: "p1", dives: 2 }, { platformId: "p3", dives: 2 }] },
      { id: "g2", name: "Boys", panel: 5, autoReveal: false, legs: [{ platformId: "p3", dives: 2 }] },
    ],
    divers: [
      { id: "d1", name: "Ana", groupId: "g1", dives: [{ code: "101B" }, { code: "201C" }, { code: "101B" }, { code: "301C" }] },
      { id: "d2", name: "Mia", groupId: "g1", dives: [{ code: "103C" }, { code: "201B" }, { code: "301B" }, { code: "401B" }] },
      { id: "d3", name: "Tom", groupId: "g2", dives: [{ code: "103B" }, { code: "203C" }] },
    ],
  });
  const state = { setup, panels: cleanPanels({ p1: ["ja", "jb", "jc"], p3: ["jd", "je"] }, setup) };
  cleanLive(state);
  return state;
}

const scoreAll = (state, pid, values) => {
  const c = state.live[pid].current;
  let revealed = false;
  values.forEach((v, i) => (revealed = judgeScore(state, pid, i + 1, c.seq, v)));
  return revealed;
};

test("a group dives its platform's rounds round by round, divers in order", () => {
  const s = fixture();
  assert.deepEqual(slotsOn(s, "g1", "p1"), [
    { diverId: "d1", round: 0 },
    { diverId: "d2", round: 0 },
    { diverId: "d1", round: 1 },
    { diverId: "d2", round: 1 },
  ]);
  assert.deepEqual(slotsOn(s, "g1", "p3").map((x) => x.round), [2, 2, 3, 3]);
  assert.equal(nextSlot(s, "p1"), null, "no group on the platform yet");
  startGroup(s, "p1", "g1");
  assert.deepEqual(nextSlot(s, "p1"), { diverId: "d1", round: 0 });
});

test("calling uses the DD for the platform height; all scores in reveals", () => {
  const s = fixture();
  startGroup(s, "p1", "g1");
  callNext(s, "p1");
  const c = s.live.p1.current;
  assert.equal(c.code, "101B");
  assert.equal(c.dd, 1.3);
  assert.equal(c.height, "1");
  assert.equal(c.scores.length, 3, "Girls have a 3-judge panel");
  assert.equal(scoreAll(s, "p1", [6, 6.5]), false);
  assert.equal(judgeScore(s, "p1", 3, c.seq, 7), true);
  const r = s.results["d1:0"];
  assert.equal(r.award, 25.35, "(6 + 6.5 + 7) × 1.3");
  assert.deepEqual(r.judges, ["ja", "jb", "jc"]);
  assert.equal(r.platformId, "p1");
  assert.throws(() => judgeScore(s, "p1", 1, c.seq, 8), /locked/);
});

test("judges can't score a stale dive, an unused seat or a bad value", () => {
  const s = fixture();
  startGroup(s, "p1", "g1");
  callNext(s, "p1");
  const seq = s.live.p1.current.seq;
  assert.throws(() => judgeScore(s, "p1", 1, seq - 1, 7), /no longer open/);
  assert.throws(() => judgeScore(s, "p1", 4, seq, 7), /isn't used/);
  assert.throws(() => judgeScore(s, "p1", 1, seq, 7.25), /half points/);
});

test("next goes through every dive on the platform, then stops", () => {
  const s = fixture();
  startGroup(s, "p1", "g1");
  const order = [];
  for (let i = 0; i < 4; i++) {
    callNext(s, "p1");
    const c = s.live.p1.current;
    order.push(`${c.diverId}:${c.round}`);
    scoreAll(s, "p1", [5, 5, 5]);
  }
  assert.deepEqual(order, ["d1:0", "d2:0", "d1:1", "d2:1"]);
  assert.deepEqual(progress(s, "g1", "p1"), { done: 4, total: 4 });
  assert.throws(() => callNext(s, "p1"), /has been scored/);
});

test("a group is on one platform at a time and moves on", () => {
  const s = fixture();
  startGroup(s, "p1", "g1");
  assert.throws(() => startGroup(s, "p3", "g1"), /Girls is on 1m/);
  assert.throws(() => startGroup(s, "p1", "g2"), /doesn't use this platform/);
  startGroup(s, "p1", null);
  startGroup(s, "p3", "g1");
  callNext(s, "p3");
  const c = s.live.p3.current;
  assert.equal(c.round, 2);
  assert.equal(c.dd, 1.5, "101B on the 3m");
  assert.equal(c.scores.length, 3);
});

test("can't switch group while a dive has scores coming in", () => {
  const s = fixture();
  startGroup(s, "p3", "g2");
  callNext(s, "p3");
  judgeScore(s, "p3", 1, s.live.p3.current.seq, 7);
  assert.throws(() => startGroup(s, "p3", null), /being scored/);
});

test("manual reveal when auto-reveal is off; override, fail and reopen", () => {
  const s = fixture();
  startGroup(s, "p3", "g2");
  callNext(s, "p3");
  assert.equal(scoreAll(s, "p3", [7, 7, 7, 7, 7]), false, "Boys reveal manually");
  setScore(s, "p3", 5, 9);
  revealNow(s, "p3");
  const r = s.results["d3:0"];
  assert.deepEqual(r.dropped, [0, 4], "one high and one low dropped with 5 judges");
  assert.equal(r.award, 21 * s.live.p3.current.dd);
  reopen(s, "p3");
  assert.equal(s.results["d3:0"], undefined);
  failDive(s, "p3");
  assert.equal(s.results["d3:0"].award, 0);
  assert.equal(s.results["d3:0"].failed, true);
});

test("changing the dive takes the table DD for the height, or a typed DD", () => {
  const s = fixture();
  startGroup(s, "p1", "g1");
  callNext(s, "p1");
  setDive(s, "p1", "103c", null);
  const c = s.live.p1.current;
  assert.equal(c.code, "103C");
  assert.equal(c.dd, 1.6);
  assert.deepEqual(s.setup.divers[0].dives[0], { code: "103C", dd: 1.6, auto: true }, "dive list updated");
  setDive(s, "p1", "103C", 1.7);
  assert.equal(c.dd, 1.7);
  assert.throws(() => setDive(s, "p1", "1011C", null), /no DD at 1m/);
  assert.throws(() => setDive(s, "p1", "xx", null), /looks wrong/);
  scoreAll(s, "p1", [6, 6, 6]);
  setDive(s, "p1", "103C", 2.0);
  assert.equal(s.results["d1:0"].award, 36, "revealed dive recalculated");
});

test("standings add up a group's dives across platforms", () => {
  const s = fixture();
  startGroup(s, "p1", "g1");
  for (let i = 0; i < 4; i++) {
    callNext(s, "p1");
    scoreAll(s, "p1", [6, 6, 6]);
  }
  startGroup(s, "p1", null);
  startGroup(s, "p3", "g1");
  callNext(s, "p3");
  scoreAll(s, "p3", [8, 8, 8]);
  const st = groupStandings(s, "g1");
  assert.equal(st[0].diverId, "d1");
  assert.equal(st[0].done, 3);
  assert.equal(st[0].rounds, 4);
  assert.equal(st[0].total, Math.round((18 * 1.3 + 18 * s.results["d1:1"].dd + 24 * 1.5) * 100) / 100);
});

test("setup changes drop results and calls for removed divers", () => {
  const s = fixture();
  startGroup(s, "p1", "g1");
  callNext(s, "p1");
  scoreAll(s, "p1", [5, 5, 5]);
  s.setup.divers = s.setup.divers.filter((d) => d.id !== "d1");
  cleanLive(s);
  assert.equal(s.results["d1:0"], undefined);
  assert.equal(s.live.p1.current, null);
  assert.equal(s.live.p1.groupId, "g1");
  assert.throws(() => call(s, "p1", "d3", 0), /isn't in Girls/);
  assert.ok(new LiveError("x") instanceof Error);
});
