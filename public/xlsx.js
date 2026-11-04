// Minimal .xlsx (Office Open XML SpreadsheetML) writer plus the results workbook
// layout. No dependencies and no DOM, so it runs in the browser and in `node --test`.
//
// A workbook is a ZIP of a few XML parts. Entries are "stored" (not compressed):
// result files are small, and it keeps the writer short with nothing to download.
import { describeDive } from "./dives.js";

// ---------- ZIP (stored entries) ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// files: [{ name, data: string | Uint8Array }] → Uint8Array
export function zip(files) {
  const enc = new TextEncoder();
  const DOS_DATE = ((2024 - 1980) << 9) | (1 << 5) | 1; // fixed date keeps output deterministic
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const name = enc.encode(f.name);
    const data = typeof f.data === "string" ? enc.encode(f.data) : f.data;
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // UTF-8 names
    local.setUint16(8, 0, true); // stored
    local.setUint16(10, 0, true); // time
    local.setUint16(12, DOS_DATE, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, data.length, true);
    local.setUint32(22, data.length, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, data);

    const cen = new DataView(new ArrayBuffer(46));
    cen.setUint32(0, 0x02014b50, true);
    cen.setUint16(4, 20, true); // version made by
    cen.setUint16(6, 20, true);
    cen.setUint16(8, 0x0800, true);
    cen.setUint16(10, 0, true);
    cen.setUint16(12, 0, true);
    cen.setUint16(14, DOS_DATE, true);
    cen.setUint32(16, crc, true);
    cen.setUint32(20, data.length, true);
    cen.setUint32(24, data.length, true);
    cen.setUint16(28, name.length, true);
    cen.setUint32(42, offset, true); // other fields stay 0
    central.push(new Uint8Array(cen.buffer), name);
    offset += 30 + name.length + data.length;
  }
  const cenSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cenSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, p) => n + p.length, 0));
  let pos = 0;
  for (const p of all) {
    out.set(p, pos);
    pos += p.length;
  }
  return out;
}

// ---------- SpreadsheetML ----------
const xml = (s) =>
  String(s)
    // characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

export function colName(i) {
  let s = "";
  for (i += 1; i > 0; i = Math.floor((i - 1) / 26)) s = String.fromCharCode(65 + ((i - 1) % 26)) + s;
  return s;
}

// Sheet names: max 31 chars, none of []:*?/\ , unique (case-insensitive).
export function sheetName(name, used = new Set()) {
  const base = String(name).replace(/[[\]:*?/\\]/g, " ").trim().slice(0, 31) || "Sheet";
  let n = base;
  for (let i = 2; used.has(n.toLowerCase()); i++) n = `${base.slice(0, 31 - String(i).length - 1)} ${i}`;
  used.add(n.toLowerCase());
  return n;
}

// Style ids, matching styles.xml below.
const S = { text: 0, header: 1, num2: 2, num1: 3, int: 0 };

// A cell value: number → numeric cell, string → inline string, null/""/undefined → empty.
// Pass { v, fmt: "num2" | "num1" } for a number format.
function cellXml(cell, ref, header) {
  const c = cell !== null && typeof cell === "object" ? cell : { v: cell };
  if (c.v === null || c.v === undefined || c.v === "") return "";
  if (typeof c.v === "number" && Number.isFinite(c.v)) {
    const s = S[c.fmt] ?? S.int;
    return `<c r="${ref}"${s ? ` s="${s}"` : ""}><v>${c.v}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"${header ? ` s="${S.header}"` : ""}><is><t xml:space="preserve">${xml(c.v)}</t></is></c>`;
}

function sheetXml(rows, widths = []) {
  const cols = widths.length
    ? `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>`
    : "";
  const body = rows
    .map((row, r) => `<row r="${r + 1}">${row.map((cell, c) => cellXml(cell, colName(c) + (r + 1), r === 0)).join("")}</row>`)
    .join("");
  const freeze = rows.length > 1 ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${freeze}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="1"><numFmt numFmtId="164" formatCode="0.0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>
<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="4">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>
<xf numFmtId="2" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

// sheets: [{ name, rows: Cell[][], widths?: number[] }] → Uint8Array (.xlsx bytes)
export function buildXlsx(sheets) {
  const used = new Set();
  const named = sheets.map((s) => ({ ...s, name: sheetName(s.name, used) }));
  const files = [
    {
      name: "[Content_Types].xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${named
        .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
        .join("")}</Types>`,
    },
    {
      name: "_rels/.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: "xl/workbook.xml",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${named
        .map((s, i) => `<sheet name="${xml(s.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
        .join("")}</sheets></workbook>`,
    },
    {
      name: "xl/_rels/workbook.xml.rels",
      data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${named
        .map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`)
        .join("")}<Relationship Id="rId${named.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
    },
    { name: "xl/styles.xml", data: STYLES },
    ...named.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s.rows, s.widths) })),
  ];
  return zip(files);
}

// ---------- results workbook ----------
const pts = (v) => ({ v: Math.round(Number(v || 0) * 100) / 100, fmt: "num2" });
const dd = (v) => (v ? { v: Number(v), fmt: "num1" } : "");
const score = (v) => (v === null || v === undefined || v === "" ? "" : Number(v));

// The referee's meet state → sheet list for buildXlsx.
// Sheets: Standings, one per round, All dives (same columns as the results CSV), Divers.
export function resultsSheets(state) {
  const judges = Array.from({ length: state.judges }, (_, i) => `J${i + 1}`);
  const byId = new Map(state.divers.map((d) => [d.id, d]));
  const ranked = state.standings.map((s) => ({ s, d: byId.get(s.diverId) })).filter((x) => x.d);
  const rounds = Array.from({ length: state.rounds }, (_, r) => r);
  const res = (d, r) => state.results[`${d.id}:${r}`];

  const standings = [
    ["Rank", "Diver", "Team", ...rounds.map((r) => `R${r + 1}`), "Total", "Dives scored"],
    ...ranked.map(({ s, d }) => [
      s.done ? s.rank : "",
      d.name,
      d.team,
      ...rounds.map((r) => (res(d, r) ? pts(res(d, r).award) : "")),
      pts(s.total),
      s.done,
    ]),
  ];

  const diveCols = ["Dive", "Description", "DD", ...judges, "Points", "Failed"];
  const diveCells = (x) => [x.code, describeDive(x.code), dd(x.dd), ...judges.map((_, i) => score(x.scores[i])), pts(x.award), x.failed ? "yes" : ""];

  const perRound = rounds.map((r) => ({
    name: `Round ${r + 1}`,
    widths: [6, 24, 18, 8, 34, 6, ...judges.map(() => 6), 9, 7],
    rows: [
      ["Rank", "Diver", "Team", ...diveCols],
      ...ranked.filter(({ d }) => res(d, r)).map(({ s, d }) => [s.done ? s.rank : "", d.name, d.team, ...diveCells(res(d, r))]),
    ],
  }));

  const all = [["Rank", "Diver", "Team", "Round", ...diveCols, "Total"]];
  for (const { s, d } of ranked)
    for (const r of rounds) if (res(d, r)) all.push([s.rank, d.name, d.team, r + 1, ...diveCells(res(d, r)), pts(s.total)]);

  const n = Math.max(state.rounds, ...state.divers.map((d) => d.dives?.length ?? 0));
  const divers = [
    ["Name", "Team", ...Array.from({ length: n }, (_, r) => [`Dive ${r + 1}`, `DD ${r + 1}`]).flat()],
    ...state.divers.map((d) => [d.name, d.team, ...Array.from({ length: n }, (_, r) => [d.dives?.[r]?.code ?? "", dd(d.dives?.[r]?.dd)]).flat()]),
  ];

  return [
    { name: "Standings", rows: standings, widths: [6, 24, 18, ...rounds.map(() => 9), 9, 12] },
    ...perRound,
    { name: "All dives", rows: all, widths: [6, 24, 18, 7, 8, 34, 6, ...judges.map(() => 6), 9, 7, 9] },
    { name: "Divers", rows: divers, widths: [24, 18, ...Array.from({ length: n }, () => [8, 6]).flat()] },
  ];
}

// A multi-platform competition (the head or platform referee's view) → sheet
// list for buildXlsx. Sheets: Summary, Standings per group, All dives (with
// the judge in each seat next to their score), Divers, Judges.
export function competitionSheets(view, { exportedAt = new Date() } = {}) {
  const platformName = new Map(view.platforms.map((p) => [p.id, p.name]));
  const judgeName = new Map(view.judges.map((j) => [j.id, j.name]));
  const diverById = new Map(view.divers.map((d) => [d.id, d]));
  const res = (d, r) => view.results[`${d.id}:${r}`];
  const seats = Math.max(3, ...view.groups.map((g) => g.panel));

  const summary = [
    ["Competition", view.name],
    ["Code", view.code],
    ["Exported", exportedAt.toISOString().slice(0, 16).replace("T", " ")],
    [],
    ["Group", "Divers", "Judges per panel", "Rotation"],
    ...view.groups.map((g) => [
      g.name,
      view.divers.filter((d) => d.groupId === g.id).length,
      g.panel,
      g.legs.map((l) => `${platformName.get(l.platformId) ?? "?"} × ${l.dives}`).join(" → "),
    ]),
  ];

  const standingsSheets = view.groups.map((g) => {
    const rounds = g.plan.map((slot, r) => ({ r, label: `D${r + 1} ${platformName.get(slot.platformId) ?? ""}`.trim() }));
    const ranked = (view.standings[g.id] || []).map((s) => ({ s, d: diverById.get(s.diverId) })).filter((x) => x.d);
    return {
      name: g.name,
      widths: [6, 24, 18, ...rounds.map(() => 10), 9, 12],
      rows: [
        ["Rank", "Diver", "Team", ...rounds.map((x) => x.label), "Total", "Dives scored"],
        ...ranked.map(({ s, d }) => [s.done ? s.rank : "", d.name, d.team, ...rounds.map(({ r }) => (res(d, r) ? pts(res(d, r).award) : "")), pts(s.total), s.done]),
      ],
    };
  });

  const seatCols = Array.from({ length: seats }, (_, i) => [`S${i + 1} judge`, `S${i + 1}`]).flat();
  const all = [["Group", "Rank", "Diver", "Team", "Dive no.", "Platform", "Height", "Dive", "Description", "DD", ...seatCols, "Points", "Failed"]];
  for (const g of view.groups) {
    for (const s of view.standings[g.id] || []) {
      const d = diverById.get(s.diverId);
      if (!d) continue;
      g.plan.forEach((slot, r) => {
        const x = res(d, r);
        if (!x) return;
        const cells = Array.from({ length: seats }, (_, i) => [i < x.scores.length ? judgeName.get(x.judges?.[i]) ?? "" : "", i < x.scores.length ? score(x.scores[i]) : ""]).flat();
        all.push([g.name, s.rank, d.name, d.team, r + 1, platformName.get(x.platformId) ?? "", x.height ? `${x.height}m` : "", x.code, describeDive(x.code), dd(x.dd), ...cells, pts(x.award), x.failed ? "yes" : ""]);
      });
    }
  }

  const groupName = new Map(view.groups.map((g) => [g.id, g.name]));
  const n = Math.max(1, ...view.divers.map((d) => d.dives?.length ?? 0));
  const divers = [
    ["Name", "Team", "Group", ...Array.from({ length: n }, (_, r) => [`Dive ${r + 1}`, `DD ${r + 1}`]).flat(), "Other dives"],
    ...view.divers.map((d) => [
      d.name,
      d.team,
      groupName.get(d.groupId) ?? "",
      ...Array.from({ length: n }, (_, r) => [d.dives?.[r]?.code ?? "", dd(d.dives?.[r]?.dd)]).flat(),
      (d.extra || []).join(" "),
    ]),
  ];

  // Who judged what: count the dives each judge scored, per platform.
  const counts = new Map();
  for (const x of Object.values(view.results)) {
    (x.judges || []).forEach((jid, i) => {
      if (!jid || i >= x.scores.length) return;
      const k = `${jid}|${x.platformId}`;
      counts.set(k, (counts.get(k) || 0) + 1);
    });
  }
  const judges = [["Judge", "Platform", "Dives scored", "Seat now"]];
  for (const j of view.judges) {
    const now = view.platforms.map((p) => ((view.panels?.[p.id] || []).indexOf(j.id) >= 0 ? `${p.name} S${view.panels[p.id].indexOf(j.id) + 1}` : "")).find(Boolean) ?? "";
    const per = view.platforms.filter((p) => counts.get(`${j.id}|${p.id}`));
    if (!per.length) judges.push([j.name, "", 0, now]);
    per.forEach((p, i) => judges.push([i ? "" : j.name, p.name, counts.get(`${j.id}|${p.id}`), i ? "" : now]));
  }

  return [
    { name: "Summary", rows: summary, widths: [22, 30, 16, 40] },
    ...standingsSheets,
    { name: "All dives", rows: all, widths: [18, 6, 24, 18, 8, 10, 8, 8, 34, 6, ...Array.from({ length: seats }, () => [16, 6]).flat(), 9, 7] },
    { name: "Divers", rows: divers, widths: [24, 18, 18, ...Array.from({ length: n }, () => [8, 6]).flat(), 20] },
    { name: "Judges", rows: judges, widths: [24, 14, 12, 12] },
  ];
}
