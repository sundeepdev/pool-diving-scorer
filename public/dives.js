// Turns a World Aquatics dive number (e.g. 107B, 5253B, 626C) into words.
const GROUPS = { 1: "Forward", 2: "Back", 3: "Reverse", 4: "Inward" };
const POSITIONS = { A: "Straight", B: "Pike", C: "Tuck", D: "Free" };

function count(halves) {
  const whole = Math.floor(halves / 2);
  return `${whole || ""}${halves % 2 ? "½" : ""}`;
}

function somersaults(h) {
  if (h === 0) return "";
  if (h === 1) return "Dive";
  if (h === 2) return "Somersault";
  return `${count(h)} Somersault${h > 2 ? "s" : ""}`;
}

function twists(t) {
  return t ? `${count(t)} Twist${t > 2 ? "s" : ""}` : "";
}

export function describeDive(code) {
  const m = String(code ?? "").toUpperCase().match(/^(\d)(\d)(\d)(\d)?([A-D])$/);
  if (!m) return "";
  const [, a, b, c, d, pos] = m;
  const n = [a, b, c, d].map(Number);
  let parts;
  if (a === "6") {
    parts = ["Armstand", GROUPS[n[1]] ?? "", somersaults(n[2]), d ? twists(n[3]) : ""];
  } else if (a === "5" && d) {
    if (!GROUPS[n[1]]) return "";
    parts = [GROUPS[n[1]], somersaults(n[2]), twists(n[3])];
  } else if (!d && GROUPS[n[0]]) {
    parts = [GROUPS[n[0]], n[1] === 1 ? "Flying" : "", somersaults(n[2])];
  } else {
    return "";
  }
  return [...parts, POSITIONS[pos]].filter(Boolean).join(" ");
}
