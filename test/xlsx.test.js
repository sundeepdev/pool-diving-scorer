import { test } from "node:test";
import assert from "node:assert/strict";
import { buildXlsx, colName, crc32, resultsSheets, sheetName, zip } from "../public/xlsx.js";
import { standings } from "../src/scoring.js";

// Read a stored-entry ZIP back via its central directory and check each CRC.
function unzip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const dec = new TextDecoder();
  const end = bytes.length - 22;
  assert.equal(dv.getUint32(end, true), 0x06054b50, "end of central directory");
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const files = {};
  for (let i = 0; i < count; i++) {
    assert.equal(dv.getUint32(p, true), 0x02014b50);
    const crc = dv.getUint32(p + 16, true);
    const size = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    assert.equal(dv.getUint32(off, true), 0x04034b50, `local header for ${name}`);
    const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
    const data = bytes.subarray(start, start + size);
    assert.equal(crc32(data), crc, `crc for ${name}`);
    files[name] = dec.decode(data);
    p += 46 + nameLen;
  }
  return files;
}

// Cells of one worksheet as { A1: "text" | number }.
function cells(sheetXml) {
  const out = {};
  for (const m of sheetXml.matchAll(/<c r="([A-Z]+\d+)"([^>]*)>(.*?)<\/c>/g)) {
    const [, ref, attrs, inner] = m;
    if (attrs.includes('t="inlineStr"')) out[ref] = inner.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
    else out[ref] = Number(inner.match(/<v>(.*)<\/v>/)[1]);
  }
  return out;
}

test("crc32 matches the standard check value", () => {
  assert.equal(crc32(new TextEncoder().encode("123456789")), 0xcbf43926);
});

test("zip round-trips names and contents", () => {
  const files = unzip(zip([{ name: "a.txt", data: "hello" }, { name: "dir/b.xml", data: "<x>é</x>" }]));
  assert.deepEqual(files, { "a.txt": "hello", "dir/b.xml": "<x>é</x>" });
});

test("column names", () => {
  assert.deepEqual([0, 25, 26, 27, 51, 52, 701, 702].map(colName), ["A", "Z", "AA", "AB", "AZ", "BA", "ZZ", "AAA"]);
});

test("sheet names are trimmed, cleaned and unique", () => {
  const used = new Set();
  assert.equal(sheetName("Round 1", used), "Round 1");
  assert.equal(sheetName("round 1", used), "round 1 2");
  assert.equal(sheetName("a/b:c", used), "a b c");
  assert.equal(sheetName("x".repeat(40), used).length, 31);
});

test("buildXlsx writes the required parts, numbers as numbers, text escaped", () => {
  const files = unzip(buildXlsx([{ name: "S", rows: [["Name", "Score"], ['Tom & "Jo" <A>', { v: 7.5, fmt: "num2" }], ["", null]] }]));
  for (const part of ["[Content_Types].xml", "_rels/.rels", "xl/workbook.xml", "xl/_rels/workbook.xml.rels", "xl/styles.xml", "xl/worksheets/sheet1.xml"])
    assert.ok(files[part], part);
  const c = cells(files["xl/worksheets/sheet1.xml"]);
  assert.deepEqual(c, { A1: "Name", B1: "Score", A2: 'Tom & "Jo" <A>', B2: 7.5 });
  assert.match(files["xl/worksheets/sheet1.xml"], /<c r="B2" s="2"><v>7.5<\/v>/);
  assert.match(files["xl/workbook.xml"], /<sheet name="S" sheetId="1" r:id="rId1"\/>/);
});

function sampleState() {
  const divers = [
    { id: "a", name: "Ana", team: "EDC", dives: [{ code: "101B", dd: 1.3 }, { code: "201C", dd: 1.5 }] },
    { id: "b", name: "Ben", team: "Leith", dives: [{ code: "103C", dd: 1.6 }, { code: "301B", dd: 1.6 }] },
    { id: "c", name: "Cal", team: "", dives: [] },
  ];
  const results = {
    "a:0": { code: "101B", dd: 1.3, scores: [6, 6.5, 7], award: 25.35, failed: false },
    "a:1": { code: "201C", dd: 1.5, scores: [5, 5, 5.5], award: 23.25, failed: false },
    "b:0": { code: "103C", dd: 1.6, scores: [7, 7, 7.5], award: 34.4, failed: false },
    "b:1": { code: "301B", dd: 1.6, scores: [0, 0, 0], award: 0, failed: true },
  };
  return { name: "Club Champs", judges: 3, rounds: 2, divers, results, standings: standings(divers, results, 2) };
}

test("results workbook: standings, rounds, all dives and divers", () => {
  const files = unzip(buildXlsx(resultsSheets(sampleState())));
  const names = [...files["xl/workbook.xml"].matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(names, ["Standings", "Round 1", "Round 2", "All dives", "Divers"]);

  const st = cells(files["xl/worksheets/sheet1.xml"]);
  assert.deepEqual([st.A1, st.B1, st.D1, st.E1, st.F1, st.G1], ["Rank", "Diver", "R1", "R2", "Total", "Dives scored"]);
  assert.deepEqual([st.A2, st.B2, st.D2, st.E2, st.F2], [1, "Ana", 25.35, 23.25, 48.6]);
  assert.deepEqual([st.A3, st.B3, st.D3, st.E3, st.F3], [2, "Ben", 34.4, 0, 34.4]);
  assert.equal(st.B4, "Cal");
  assert.equal(st.A4, undefined, "no rank before any dive is scored");
  assert.equal(st.F4, 0);

  const r2 = cells(files["xl/worksheets/sheet3.xml"]);
  assert.deepEqual([r2.B2, r2.D2, r2.F2, r2.G2, r2.H2, r2.I2, r2.J2], ["Ana", "201C", 1.5, 5, 5, 5.5, 23.25]);
  assert.equal(r2.K3, "yes", "failed dive flagged");
  assert.equal(r2.B4, undefined, "only divers with a dive in this round");

  const all = cells(files["xl/worksheets/sheet4.xml"]);
  assert.deepEqual(
    Object.keys(all).filter((k) => k.endsWith("1")).map((k) => all[k]),
    ["Rank", "Diver", "Team", "Round", "Dive", "Description", "DD", "J1", "J2", "J3", "Points", "Failed", "Total"],
  );
  assert.deepEqual([all.A2, all.B2, all.D2, all.E2, all.K2, all.M2], [1, "Ana", 1, "101B", 25.35, 48.6]);
  assert.equal(all.A6, undefined, "four dives, one header");

  const dv = cells(files["xl/worksheets/sheet5.xml"]);
  assert.deepEqual([dv.A1, dv.C1, dv.D1, dv.A3, dv.E3, dv.F3, dv.A4], ["Name", "Dive 1", "DD 1", "Ben", "301B", 1.6, "Cal"]);
});
