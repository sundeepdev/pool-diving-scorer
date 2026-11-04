import { test } from "node:test";
import assert from "node:assert/strict";
import { SetupError, normalizeSetup, roundPlan, setupWarnings } from "../public/competition-model.js";
import { DD_TABLE, divesAtHeight, lookupDD } from "../public/ddtable.js";
import { competitionDiversToCsv, parseImport } from "../public/importer.js";

test("DD table matches the worked examples in the World Aquatics rules", () => {
  // Appendix 8 (springboard) and Appendix 10 (platform) examples.
  assert.equal(lookupDD("207B", "3"), 3.9);
  assert.equal(lookupDD("207C", "3"), 3.6);
  assert.equal(lookupDD("309B", "3"), 4.7);
  assert.equal(lookupDD("5253B", "3"), 3.4);
  assert.equal(lookupDD("5255B", "3"), 3.8);
  assert.equal(lookupDD("5355B", "3"), 3.7);
  assert.equal(lookupDD("313C", "3"), 2.2);
  assert.equal(lookupDD("307B", "10"), 3.7);
  assert.equal(lookupDD("307C", "10"), 3.4);
  assert.equal(lookupDD("309B", "10"), 4.8);
  assert.equal(lookupDD("5371B", "10"), 3.3);
  assert.equal(lookupDD("6247D", "10"), 4.0);
});

test("DD table spot checks across heights", () => {
  assert.equal(lookupDD("101B", "1"), 1.3);
  assert.equal(lookupDD("101B", "3"), 1.5);
  assert.equal(lookupDD("101b", 5), 1.3);
  assert.equal(lookupDD("105B", "10"), 2.3);
  assert.equal(lookupDD("612B", "7.5"), 1.8);
  assert.equal(lookupDD("1011C", "10"), 4.7);
  assert.equal(lookupDD("1011C", "3"), null, "5½ somersaults only on 10m");
  assert.equal(lookupDD("610A", "1"), null, "no armstands on springboard");
  assert.equal(lookupDD("999Z", "3"), null);
  assert.ok(Object.keys(DD_TABLE).length > 250);
  assert.ok(divesAtHeight("10").includes("626C"));
  for (const [dive, row] of Object.entries(DD_TABLE)) {
    assert.match(dive, /^\d{3,4}[A-D]$/);
    for (const [h, dd] of Object.entries(row)) {
      assert.ok(["1", "3", "5", "7.5", "10"].includes(h), `${dive} height ${h}`);
      assert.ok(dd >= 1 && dd <= 5, `${dive} ${h}m DD ${dd}`);
    }
  }
});

const base = () => ({
  name: "Club Champs",
  platforms: [
    { id: "p1", name: "1m", height: "1" },
    { id: "p3", name: "3m", height: "3" },
  ],
  judges: [
    { id: "j1", name: "Alex" },
    { id: "j2", name: "Sam" },
    { id: "j3", name: "Jo" },
  ],
  groups: [
    {
      id: "g1",
      name: "Girls 12-13",
      panel: 3,
      legs: [
        { platformId: "p1", dives: 2 },
        { platformId: "p3", dives: 2 },
      ],
    },
  ],
  divers: [
    { id: "d1", name: "Ana", team: "EDC", groupId: "g1", dives: [{ code: "101b" }, { code: "201C" }, { code: "101B" }, { code: "301C", dd: 2.2 }], extra: ["103c"] },
  ],
});

test("rotation decides each round's height and the DD comes from the table", () => {
  const s = normalizeSetup(base());
  assert.deepEqual(
    roundPlan(s.groups[0], s.platforms).map((r) => r.height),
    ["1", "1", "3", "3"],
  );
  const d = s.divers[0];
  assert.deepEqual(d.dives[0], { code: "101B", dd: 1.3, auto: true });
  assert.equal(d.dives[1].dd, lookupDD("201C", "1"));
  assert.deepEqual(d.dives[2], { code: "101B", dd: 1.5, auto: true }, "same dive, higher board, different DD");
  assert.deepEqual(d.dives[3], { code: "301C", dd: 2.2, auto: false }, "a typed DD is kept");
  assert.deepEqual(d.extra, ["103C"]);
  assert.deepEqual(setupWarnings(s), []);
});

test("auto DD follows a rotation change, typed DD does not", () => {
  const first = normalizeSetup(base());
  const changed = structuredClone(first);
  changed.groups[0].legs = [{ platformId: "p3", dives: 4 }];
  const s = normalizeSetup(changed);
  assert.equal(s.divers[0].dives[0].dd, 1.5, "101B now on 3m");
  assert.equal(s.divers[0].dives[3].dd, 2.2, "typed DD kept");
});

test("validation errors name the problem", () => {
  const bad = (mut, re) => {
    const s = base();
    mut(s);
    assert.throws(() => normalizeSetup(s), (err) => err instanceof SetupError && re.test(err.message));
  };
  bad((s) => (s.platforms[0].height = "2"), /height must be one of/);
  bad((s) => (s.groups[0].legs[0].platformId = "nope"), /platform that doesn't exist/);
  bad((s) => (s.groups[0].panel = 4), /3, 5 or 7/);
  bad((s) => (s.divers[0].groupId = "g9"), /unknown group/);
  bad((s) => (s.divers[0].dives[0].code = "1X1"), /not a dive number/);
  bad((s) => (s.divers[0].extra = ["oops"]), /other dives is not a dive number/);
  bad((s) => (s.judges[1].id = "j1"), /used twice/);
  bad((s) => (s.groups[0].legs = [{ platformId: "p1", dives: 13 }]), /1–12 dives/);
  bad((s) => (s.divers[0].name = " "), /needs a name/);
});

test("warnings list what still needs doing", () => {
  const s = base();
  s.groups.push({ id: "g2", name: "Boys", panel: 5, legs: [] });
  s.divers.push({ id: "d2", name: "Tom", groupId: "g1", dives: [{ code: "101B" }] });
  s.divers.push({ id: "d3", name: "Lee", groupId: null, dives: [] });
  s.divers.push({ id: "d4", name: "Kim", groupId: "g1", dives: [{ code: "1011C" }, { code: "101B" }, { code: "101B" }, { code: "101B" }] });
  const msgs = setupWarnings(normalizeSetup(s)).map((w) => w.message);
  assert.ok(msgs.includes("Boys: set the rotation (which platform, how many dives)"));
  assert.ok(msgs.includes("Boys: no divers"));
  assert.ok(msgs.includes("Tom: dive 2 is missing"));
  assert.ok(msgs.includes("Kim: 1011C has no DD at 1m, enter it by hand"));
  assert.ok(msgs.includes("1 diver(s) are not in a group"));
});

test("import reads Group and Other dives columns, export round-trips", () => {
  const { divers } = parseImport(
    "Name,Team,Group,Dive 1,DD 1,Dive 2,DD 2,Other dives\nAna,EDC,Girls 12-13,101B,,201C,1.5,103C 5132D\nTom,EDC,Boys,103C,,,,\n",
  );
  assert.equal(divers.length, 2);
  assert.deepEqual(divers[0], {
    name: "Ana",
    team: "EDC",
    dives: [
      { code: "101B", dd: 0 },
      { code: "201C", dd: 1.5 },
    ],
    group: "Girls 12-13",
    extra: ["103C", "5132D"],
  });
  assert.equal(divers[1].group, "Boys");

  const groups = [{ id: "g1", name: "Girls 12-13" }];
  const csv = competitionDiversToCsv(
    [{ name: "Ana", team: "EDC", groupId: "g1", dives: [{ code: "101B", dd: 1.3, auto: true }, { code: "201C", dd: 1.5, auto: false }], extra: ["103C"] }],
    groups,
  );
  assert.equal(csv.split("\r\n")[1], "Ana,EDC,Girls 12-13,101B,,201C,1.5,103C", "auto DD is left blank so it refills for the height");
  const back = parseImport(csv).divers[0];
  assert.equal(back.group, "Girls 12-13");
  assert.deepEqual(back.extra, ["103C"]);
});

test("import without a header row picks up a group after the team", () => {
  const { divers } = parseImport("Ana\tEDC\tGirls A\t101B\t201C");
  assert.equal(divers[0].group, "Girls A");
  assert.deepEqual(
    divers[0].dives.map((d) => d.code),
    ["101B", "201C"],
  );
});
