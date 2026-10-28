import { test } from "node:test";
import assert from "node:assert/strict";
import { computeAward, isValidScore, parseDiversText, standings } from "../src/scoring.js";
import { describeDive } from "../public/dives.js";

test("5 judges: drop high and low, sum middle three × DD", () => {
  const r = computeAward([7, 7.5, 6.5, 8, 7], 2.4);
  assert.deepEqual(r.dropped, [2, 3]);
  assert.equal(r.sum, 21.5);
  assert.equal(r.award, 51.6);
});

test("7 judges: drop two highest and two lowest", () => {
  const r = computeAward([8, 8.5, 7.5, 9, 8, 7, 8.5], 3.2);
  assert.deepEqual(r.dropped.sort(), [2, 3, 5, 6].sort());
  assert.equal(r.sum, 24.5);
  assert.equal(r.award, 78.4);
});

test("3 judges: all scores count", () => {
  const r = computeAward([6, 6.5, 7], 1.9);
  assert.deepEqual(r.dropped, []);
  assert.equal(r.award, 37.05);
});

test("ties are dropped deterministically and the award is unaffected", () => {
  const r = computeAward([7, 7, 7, 7, 7], 2.0);
  assert.equal(r.dropped.length, 2);
  assert.equal(r.award, 42);
});

test("no floating point drift", () => {
  assert.equal(computeAward([8.5, 8.5, 8.5, 8.5, 8.5], 3.3).award, 84.15);
  assert.equal(computeAward([0, 0, 0, 0, 0], 3.3).award, 0);
});

test("score validation", () => {
  for (const v of [0, 0.5, 5, 9.5, 10]) assert.ok(isValidScore(v), String(v));
  for (const v of [-0.5, 10.5, 7.25, NaN, "7", null]) assert.ok(!isValidScore(v), String(v));
});

test("diver list parsing", () => {
  const d = parseDiversText("Ana Silva, BRA, 105B 2.4, 5253b 3.4\n\nTom Lee\nKim; 101A 1.6");
  assert.equal(d.length, 3);
  assert.deepEqual(d[0], { name: "Ana Silva", team: "BRA", dives: [{ code: "105B", dd: 2.4 }, { code: "5253B", dd: 3.4 }] });
  assert.deepEqual(d[1], { name: "Tom Lee", team: "", dives: [] });
  assert.deepEqual(d[2].dives, [{ code: "101A", dd: 1.6 }]);
});

test("standings rank ties equally", () => {
  const divers = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const results = { "a:0": { award: 50 }, "b:0": { award: 60 }, "c:0": { award: 50 } };
  const s = standings(divers, results, 1);
  assert.deepEqual(s.map((r) => [r.diverId, r.rank]), [["b", 1], ["a", 2], ["c", 2]]);
});

test("dive descriptions", () => {
  assert.equal(describeDive("105B"), "Forward 2½ Somersaults Pike");
  assert.equal(describeDive("101A"), "Forward Dive Straight");
  assert.equal(describeDive("5253B"), "Back 2½ Somersaults 1½ Twists Pike");
  assert.equal(describeDive("407C"), "Inward 3½ Somersaults Tuck");
  assert.equal(describeDive("112B"), "Forward Flying Somersault Pike");
  assert.equal(describeDive("626C"), "Armstand Back 3 Somersaults Tuck");
  assert.equal(describeDive("5132D"), "Forward 1½ Somersaults 1 Twist Free");
  assert.equal(describeDive("xyz"), "");
});

import { parseImport, diversToCsv } from "../public/importer.js";

test("import: separate code / DD columns with header", () => {
  const { divers, warnings } = parseImport("Name,Team,Dive 1,DD 1,Dive 2,DD 2\nAna Silva,BRA,105B,2.4,203C,2.0\n\"Lee, Tom\",,101a,1.6\n");
  assert.deepEqual(warnings, []);
  assert.deepEqual(divers, [
    { name: "Ana Silva", team: "BRA", dives: [{ code: "105B", dd: 2.4 }, { code: "203C", dd: 2 }] },
    { name: "Lee, Tom", team: "", dives: [{ code: "101A", dd: 1.6 }] },
  ]);
});

test("import: pasted from a spreadsheet (tabs), combined cells, decimal commas", () => {
  const { divers } = parseImport("Mia Chen\tCHN\t107B 3.1\t205B/3.0\nKim\t5253B\t3,4\n");
  assert.deepEqual(divers[0].dives, [{ code: "107B", dd: 3.1 }, { code: "205B", dd: 3 }]);
  assert.deepEqual(divers[1], { name: "Kim", team: "", dives: [{ code: "5253B", dd: 3.4 }] });
});

test("import: warnings for bad cells", () => {
  const { divers, warnings } = parseImport("Ana;BRA;105X;2.4;203C\n;GBR;101A;1.6");
  assert.equal(divers.length, 1);
  assert.equal(warnings.length, 3);
});

test("export round-trips through import", () => {
  const divers = [{ name: "Ana, Jr", team: "BRA", dives: [{ code: "105B", dd: 2.4 }, null, { code: "305C", dd: 3 }] }];
  const back = parseImport(diversToCsv(divers, 3)).divers;
  assert.equal(back[0].name, "Ana, Jr");
  assert.deepEqual(back[0].dives.map((d) => d?.code ?? null), ["105B", null, "305C"]);
});
