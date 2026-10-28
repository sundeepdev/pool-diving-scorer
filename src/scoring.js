// Pure scoring logic shared by the Durable Object and the tests.
//
// World Aquatics individual-event rules: every judge awards 0–10 in half
// points. With 7 judges the two highest and two lowest are dropped, with 5
// judges the highest and lowest are dropped, with 3 judges all count. The
// three remaining scores are summed and multiplied by the degree of
// difficulty (DD).

export const JUDGE_PANELS = [3, 5, 7];

export function isValidScore(v) {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 10 && Number.isInteger(v * 2);
}

export function isValidDD(dd) {
  return typeof dd === "number" && Number.isFinite(dd) && dd > 0 && dd <= 5;
}

// Returns { counted: [judgeIdx], dropped: [judgeIdx], sum, award }.
// Ties are broken by judge order so the result is deterministic.
export function computeAward(scores, dd) {
  const n = scores.length;
  const drop = Math.max(0, Math.floor((n - 3) / 2));
  const order = scores.map((v, i) => i).sort((a, b) => scores[a] - scores[b] || a - b);
  const dropped = [...order.slice(0, drop), ...order.slice(n - drop)].sort((a, b) => a - b);
  const counted = order.slice(drop, n - drop).sort((a, b) => a - b);
  // Integer arithmetic: scores in halves, DD in hundredths.
  const halves = counted.reduce((t, i) => t + Math.round(scores[i] * 2), 0);
  const ddHundredths = Math.round(dd * 100);
  return {
    counted,
    dropped,
    sum: halves / 2,
    award: Math.round((halves * ddHundredths) / 2) / 100,
  };
}

const DIVE_RE = /^(\d{3,4}[A-D])\s+(\d(?:\.\d{1,2})?)$/i;
const CODE_RE = /^\d{3,4}[A-D]$/i;

export function normalizeDiveCode(code) {
  const c = String(code ?? "").trim().toUpperCase();
  return CODE_RE.test(c) ? c : null;
}

// Parses the diver list typed by the referee. One diver per line:
//   Name, Team, 105B 2.4, 203C 2.0, ...
// Team and dives are optional. Returns [{ name, team, dives: [{code, dd}] }].
export function parseDiversText(text) {
  const divers = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const fields = raw.split(/[,;\t]/).map((f) => f.trim()).filter(Boolean);
    if (!fields.length) continue;
    const diver = { name: fields[0].slice(0, 60), team: "", dives: [] };
    for (const f of fields.slice(1)) {
      const m = f.match(DIVE_RE);
      if (m) diver.dives.push({ code: m[1].toUpperCase(), dd: Number(m[2]) });
      else if (!diver.team) diver.team = f.slice(0, 40);
    }
    divers.push(diver);
  }
  return divers;
}

export function diversToText(divers) {
  return divers
    .map((d) => [d.name, d.team, ...d.dives.filter(Boolean).map((x) => `${x.code} ${x.dd}`)].filter(Boolean).join(", "))
    .join("\n");
}

export const slotKey = (diverId, round) => `${diverId}:${round}`;

// Running totals and ranks (equal totals share a rank).
export function standings(divers, results, rounds) {
  const rows = divers.map((d) => {
    let total = 0;
    let done = 0;
    for (let r = 0; r < rounds; r++) {
      const res = results[slotKey(d.id, r)];
      if (res) {
        total += res.award;
        done++;
      }
    }
    return { diverId: d.id, total: Math.round(total * 100) / 100, done };
  });
  rows.sort((a, b) => b.total - a.total);
  rows.forEach((row, i) => {
    row.rank = i > 0 && row.total === rows[i - 1].total ? rows[i - 1].rank : i + 1;
  });
  return rows;
}
