// Turns a spreadsheet export (CSV/TSV) or text pasted from Excel / Google
// Sheets into a diver list. Accepted row layouts (header row optional):
//   Name, Team, 105B, 2.4, 203C, 2.0, ...      (code and DD in separate columns)
//   Name, Team, 105B 2.4, 203C 2.0, ...        (code and DD in one cell)
//   Name, 105B 2.4, ...                        (no team)
//   Name, Team, Group, 105B, 203C, ...          (group / age group, DD optional)
// With a header row, a "Group" (or Category, Age group, Level) column and an
// "Other dives" (or Can also do, Repertoire) column are also recognised.

const CODE = /^\d{3,4}[A-D]$/i;
const NUM = /^\d(?:[.,]\d{1,2})?$/;
const COMBINED = /^(\d{3,4}[A-D])[\s/:(]+(\d(?:[.,]\d{1,2})?)\)?$/i;

const toDD = (s) => Number(String(s).replace(",", "."));

export function detectDelimiter(text) {
  const line = String(text).split(/\r?\n/).find((l) => l.trim()) ?? "";
  if (line.includes("\t")) return "\t";
  const count = (ch) => line.split(ch).length - 1;
  return count(";") > count(",") ? ";" : ",";
}

// Minimal RFC 4180 parser (quoted fields, escaped quotes, CRLF).
export function parseDelimited(text, delim) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;
  const src = String(text).replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"' && src[i + 1] === '"') field += src[++i];
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"' && field === "") quoted = true;
    else if (ch === delim) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const looksLikeDive = (c) => CODE.test(c) || COMBINED.test(c);

function parseDive(code, dd, where, warnings) {
  const m = code.match(COMBINED);
  if (m) return { code: m[1].toUpperCase(), dd: toDD(m[2]) };
  if (!CODE.test(code)) {
    warnings.push(`${where}: "${code}" isn't a dive number — ignored`);
    return null;
  }
  if (!NUM.test(dd ?? "")) {
    warnings.push(`${where}: ${code.toUpperCase()} has no DD`);
    return { code: code.toUpperCase(), dd: 0 };
  }
  return { code: code.toUpperCase(), dd: toDD(dd) };
}

// With a header row like "Name, Team, Dive 1, DD 1, Dive 2, DD 2" columns are
// matched by name, so an empty round stays empty instead of shifting.
function headerLayout(cells) {
  if (!/^(name|diver|athlete|competitor)\b/i.test(cells[0] ?? "")) return null;
  const layout = { team: -1, group: -1, extra: -1, rounds: [] };
  cells.forEach((h, col) => {
    let m;
    if (/^(team|club|country|nation|noc)/i.test(h)) layout.team = col;
    else if (/^(group|category|age ?group|level|flight|squad)/i.test(h)) layout.group = col;
    else if (/^(other dives|can also|repertoire|dive list|extra|spare)/i.test(h)) layout.extra = col;
    else if ((m = h.match(/^(?:dive|code)\s*#?\s*(\d+)$/i))) (layout.rounds[m[1] - 1] ??= {}).code = col;
    else if ((m = h.match(/^(?:dd|dod|difficulty)\s*#?\s*(\d+)$/i))) (layout.rounds[m[1] - 1] ??= {}).dd = col;
  });
  return layout;
}

export function rowsToDivers(rows) {
  const divers = [];
  const warnings = [];
  const trimmed = rows.map((r) => r.map((c) => String(c ?? "").trim()));
  const layout = trimmed.length ? headerLayout(trimmed[0]) : null;
  trimmed.forEach((cells, idx) => {
    if (cells.every((c) => !c) || (idx === 0 && layout)) return;
    const name = cells[0];
    if (!name) return warnings.push(`Row ${idx + 1}: no name — skipped`);
    const where = `Row ${idx + 1} (${name})`;
    let team = "";
    let group = "";
    let extra = [];
    let dives = [];
    if (layout) {
      group = layout.group >= 0 ? cells[layout.group] ?? "" : "";
      if (layout.extra >= 0) extra = parseExtra(cells[layout.extra] ?? "", where, warnings);
    }
    if (layout && layout.rounds.length) {
      team = layout.team >= 0 ? cells[layout.team] ?? "" : "";
      dives = Array.from(layout.rounds, (cols) => {
        const code = cols?.code !== undefined ? cells[cols.code] ?? "" : "";
        return code ? parseDive(code, cols.dd !== undefined ? cells[cols.dd] : "", where, warnings) : null;
      });
      while (dives.length && !dives[dives.length - 1]) dives.pop();
    } else {
      let i = 1;
      if (i < cells.length && !looksLikeDive(cells[i])) team = cells[i++];
      if (!layout && i < cells.length && cells[i] && !looksLikeDive(cells[i]) && !NUM.test(cells[i])) group = cells[i++];
      while (i < cells.length) {
        const c = cells[i];
        if (!c) {
          i++;
          continue;
        }
        const pairsWithNext = !COMBINED.test(c) && NUM.test(cells[i + 1] ?? "");
        const dive = parseDive(c, pairsWithNext ? cells[i + 1] : "", where, warnings);
        if (dive) dives.push(dive);
        i += pairsWithNext ? 2 : 1;
      }
    }
    const diver = { name: name.slice(0, 60), team: team.slice(0, 40), dives };
    if (group) diver.group = group.slice(0, 60);
    if (extra.length) diver.extra = extra;
    divers.push(diver);
  });
  return { divers, warnings };
}

function parseExtra(cell, where, warnings) {
  const out = [];
  for (const tok of String(cell).split(/[\s,;/]+/).filter(Boolean)) {
    if (CODE.test(tok)) out.push(tok.toUpperCase());
    else warnings.push(`${where}: "${tok}" in other dives isn't a dive number — ignored`);
  }
  return out;
}

export function parseImport(text) {
  return rowsToDivers(parseDelimited(text, detectDelimiter(text)));
}

export function diversToCsv(divers, rounds) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
  const n = Math.max(rounds, ...divers.map((d) => d.dives.length));
  const header = ["Name", "Team", ...Array.from({ length: n }, (_, r) => [`Dive ${r + 1}`, `DD ${r + 1}`]).flat()];
  const lines = divers.map((d) => [d.name, d.team, ...Array.from({ length: n }, (_, r) => [d.dives[r]?.code ?? "", d.dives[r]?.dd || ""]).flat()]);
  return [header, ...lines].map((l) => l.map(q).join(",")).join("\r\n") + "\r\n";
}

// Competition diver list: Name, Team, Group, Dive 1, DD 1, ..., Other dives.
export function competitionDiversToCsv(divers, groups) {
  const q = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ""));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  const n = Math.max(1, ...divers.map((d) => d.dives.length));
  const header = ["Name", "Team", "Group", ...Array.from({ length: n }, (_, r) => [`Dive ${r + 1}`, `DD ${r + 1}`]).flat(), "Other dives"];
  const lines = divers.map((d) => [
    d.name,
    d.team,
    groupName.get(d.groupId) ?? "",
    ...Array.from({ length: n }, (_, r) => [d.dives[r]?.code ?? "", d.dives[r]?.dd && !d.dives[r]?.auto ? d.dives[r].dd : ""]).flat(),
    (d.extra || []).join(" "),
  ]);
  return [header, ...lines].map((l) => l.map(q).join(",")).join("\r\n") + "\r\n";
}
