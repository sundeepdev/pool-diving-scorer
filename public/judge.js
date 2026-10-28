import { $, api, confirmDialog, diverById, esc, fmtDD, fmtPts, fmtScore, liveSocket, meetCodeFromUrl, store } from "/common.js";
import { describeDive } from "/dives.js";

let code = meetCodeFromUrl();
let creds = null;
let sock = null;
let state = null;
let online = false;
let whole = null; // selected whole number, or null
let half = false;
let pending = null; // { seq, value } sent but not yet acknowledged
let lastSeq = null;
let ref = 0;

const selection = () => (whole === null ? null : whole + (half ? 0.5 : 0));
const buzz = (ms) => navigator.vibrate?.(ms);

function toast(text, ms = 2500) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), ms);
}

// ---------- theme + screen wake lock ----------
function applyTheme(theme) {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
}
applyTheme(store.get("judge-theme"));
$("#themeBtn").addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  store.set("judge-theme", next);
  applyTheme(next);
});

let wakeLock = null;
async function keepAwake() {
  try {
    if (!wakeLock && navigator.wakeLock && !document.hidden) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => (wakeLock = null));
    }
  } catch {}
}
document.addEventListener("visibilitychange", keepAwake);
document.addEventListener("pointerdown", keepAwake, { once: true });

// ---------- sign-in ----------
async function showJoin(message) {
  $("#pad").classList.add("hidden");
  $("#join").classList.remove("hidden");
  document.body.classList.remove("judge");
  $("#joinCode").value = code;
  if (message) $("#joinErr").textContent = message;
  await loadSeats();
}

let seat = null;
async function loadSeats() {
  const c = $("#joinCode").value.toUpperCase();
  const box = $("#seats");
  if (c.length !== 6) {
    box.innerHTML = `<span class="muted">Enter the meet code first</span>`;
    return;
  }
  try {
    const meet = await api(`/api/meets/${c}`);
    $("#joinMeetName").textContent = meet.name;
    box.innerHTML = Array.from({ length: meet.judges }, (_, i) =>
      `<button type="button" class="btn ${seat === i + 1 ? "primary" : ""}" data-seat="${i + 1}" style="flex:1 0 56px;min-height:56px;font-size:20px">${i + 1}</button>`
    ).join("");
  } catch (err) {
    box.innerHTML = `<span class="error">${esc(err.message)}</span>`;
  }
}
$("#joinCode").addEventListener("input", (e) => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
  loadSeats();
});
$("#seats").addEventListener("click", (e) => {
  const b = e.target.closest("[data-seat]");
  if (!b) return;
  seat = Number(b.dataset.seat);
  for (const x of $("#seats").children) x.classList.toggle("primary", x === b);
});
$("#joinForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#joinErr").textContent = "";
  if (!seat) return ($("#joinErr").textContent = "Choose your judge seat");
  const c = $("#joinCode").value.toUpperCase();
  const pin = $("#joinPin").value.trim();
  try {
    await api(`/api/meets/${c}/auth`, { role: "judge", judge: seat, key: pin });
    code = c;
    creds = { judge: seat, pin };
    store.set(`judge:${code}`, creds);
    history.replaceState(null, "", `?meet=${code}`);
    startPad();
  } catch (err) {
    $("#joinErr").textContent = err.message;
  }
});

$("#leaveBtn").addEventListener("click", async () => {
  if (!(await confirmDialog("Leave this judge seat?", { ok: "Leave", danger: true }))) return;
  store.remove(`judge:${code}`);
  location.href = `/judge?meet=${code}`;
});

// ---------- scoring pad ----------
function buildKeypad() {
  const keys = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  $("#keypad").innerHTML =
    keys.map((n) => `<button class="key" data-n="${n}" aria-label="${n}">${n}</button>`).join("") +
    `<button class="key half" data-half aria-label="plus one half">+½</button>`;
}

$("#keypad").addEventListener("pointerdown", (e) => {
  const k = e.target.closest(".key");
  if (!k || k.disabled) return;
  e.preventDefault(); // react on touch-down for speed, and avoid double-tap zoom
  if (k.dataset.half !== undefined) toggleHalf();
  else pick(Number(k.dataset.n));
});
// Keyboard activation of a focused key (Enter/Space) arrives as a click with detail 0.
$("#keypad").addEventListener("click", (e) => {
  const k = e.target.closest(".key");
  if (!k || e.detail !== 0) return;
  if (k.dataset.half !== undefined) toggleHalf();
  else pick(Number(k.dataset.n));
});

function canScore() {
  return state?.current?.phase === "scoring";
}

function pick(n) {
  if (!canScore()) return;
  whole = n;
  if (n === 10) half = false;
  buzz(8);
  render();
}

function toggleHalf() {
  if (!canScore()) return;
  if (whole === null) {
    // Allow "+½" on a score already sent, e.g. 7 → 7.5
    const mine = state.myScore;
    if (mine === null || mine === undefined) return;
    whole = Math.floor(mine);
    half = mine % 1 === 0;
  } else half = !half;
  if (whole === 10) half = false;
  buzz(8);
  render();
}

function send() {
  const value = selection();
  if (value === null || !canScore()) return;
  const seq = state.current.seq;
  pending = { seq, value, ref: ++ref };
  whole = null;
  half = false;
  if (!sock.send({ type: "score", seq, value, ref: pending.ref })) toast("Offline — will send when reconnected");
  buzz(25);
  render();
}
$("#sendBtn").addEventListener("click", send);

// Keyboard: digits, "10" (type 1 then 0), "." or "h" for half, Enter to send, Esc/Backspace to clear.
let lastKey = { key: null, at: 0 };
document.addEventListener("keydown", (e) => {
  if ($("#pad").classList.contains("hidden") || e.target.closest("dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
  const now = Date.now();
  if (/^[0-9]$/.test(e.key)) {
    if (e.key === "0" && lastKey.key === "1" && now - lastKey.at < 800 && whole === 1) pick(10);
    else pick(Number(e.key));
  } else if ([".", ",", "h", "H", "+"].includes(e.key)) toggleHalf();
  else if (e.key === "Enter") send();
  else if (e.key === "Escape" || e.key === "Backspace") {
    whole = null;
    half = false;
    render();
  } else return;
  e.preventDefault();
  lastKey = { key: e.key, at: now };
});

function onState(s) {
  state = s;
  const seq = s.current?.seq ?? null;
  if (seq !== lastSeq) {
    if (seq !== null && s.current.phase === "scoring" && lastSeq !== null) buzz([40, 60, 40]);
    lastSeq = seq;
    whole = null;
    half = false;
    if (pending && pending.seq !== seq) pending = null;
  }
  if (pending && s.myScore === pending.value) pending = null;
  render();
}

function onMessage(msg) {
  if (msg.type === "ack" && pending && msg.ref === pending.ref) {
    pending = null;
    render();
  } else if (msg.type === "error") {
    if (pending && msg.ref === pending.ref) pending = null;
    toast(msg.message);
    render();
  }
}

function onStatus(status) {
  online = status === "online";
  $("#connDot").className = `dot ${status}`;
  $("#connText").textContent = status === "online" ? "Live" : status === "connecting" ? "Connecting" : "Offline";
  $("#offlineBanner").classList.toggle("hidden", status !== "offline");
  if (online && pending && state?.current?.seq === pending.seq) {
    sock.send({ type: "score", seq: pending.seq, value: pending.value, ref: pending.ref });
  }
}

function render() {
  if (!state) return;
  const c = state.current;
  $("#meetName").textContent = [state.name, state.event].filter(Boolean).join(" · ");
  $("#seatPill").textContent = `Judge ${state.me}`;

  const diver = c && diverById(state, c.diverId);
  $("#diveCard").innerHTML = diver
    ? `<div class="who">${esc(diver.name)}</div>
       <div class="meta"><span>Round <b>${c.round + 1}</b>/${state.rounds}</span>${diver.team ? `<span>${esc(diver.team)}</span>` : ""}
       <span><b class="mono">${esc(c.code || "—")}</b> ${esc(describeDive(c.code))}</span><span>DD <b class="mono">${fmtDD(c.dd)}</b></span></div>`
    : `<div class="who">Waiting for next diver</div><div class="meta">${esc(state.name)}</div>`;

  const scoring = c?.phase === "scoring";
  const revealed = c?.phase === "revealed";
  const sel = selection();
  const mine = state.myScore;

  // readout
  const ro = $("#readout");
  ro.classList.toggle("sent", scoring && sel === null && !pending && mine !== null);
  ro.classList.toggle("pending", !!pending);
  let value = "–";
  let status = "";
  if (!c) status = "No dive called";
  else if (pending) {
    value = fmtScore(pending.value);
    status = online ? "Sending…" : "Queued — offline";
  } else if (sel !== null) {
    value = fmtScore(sel);
    status = mine === null ? "Tap SEND" : `Sent ${fmtScore(mine)} · tap UPDATE`;
  } else if (mine !== null && mine !== undefined) {
    value = fmtScore(mine);
    status = revealed ? "Locked" : "Sent ✓ · tap a number to change";
  } else status = scoring ? "Enter your score" : "";
  $("#readValue").textContent = value;
  $("#readStatus").textContent = status;

  // keypad vs. waiting / result panel
  const showPad = scoring;
  $("#keypad").classList.toggle("hidden", !showPad);
  $("#padWait").classList.toggle("hidden", showPad);
  if (showPad) {
    for (const k of $("#keypad").children) {
      if (k.dataset.half !== undefined) {
        k.classList.toggle("on", half);
        k.disabled = whole === 10 || (whole === null && (mine === null || mine === 10));
      } else k.classList.toggle("sel", Number(k.dataset.n) === whole);
    }
  } else if (revealed) {
    const res = state.results[`${c.diverId}:${c.round}`];
    $("#padWait").innerHTML = `<div style="width:100%">
      <h2>${res?.failed ? "Failed dive" : "Scores in"}</h2>
      <div class="tiles" style="--n:${c.scores.length};margin:12px 0">${c.scores
        .map((v, i) => `<div class="tile ${res?.dropped.includes(i) ? "dropped" : "in"}"><div class="j">J${i + 1}${i + 1 === state.me ? " · YOU" : ""}</div><div class="s">${fmtScore(v)}</div></div>`)
        .join("")}</div>
      <div style="font-size:22px">Award <b class="mono" style="font-size:34px;color:var(--gold)">${fmtPts(res?.award)}</b></div>
      <p>Waiting for the referee to call the next diver…</p></div>`;
  } else {
    const nx = state.next && diverById(state, state.next.diverId);
    $("#padWait").innerHTML = `<div><h2>Stand by</h2><p>The referee hasn't called a dive yet.</p>${
      nx ? `<p>Up next: <b>${esc(nx.name)}</b> · round ${state.next.round + 1}</p>` : ""
    }</div>`;
  }

  const btn = $("#sendBtn");
  btn.disabled = !scoring || sel === null || !!pending;
  btn.textContent = !scoring ? (revealed ? "LOCKED" : "WAITING") : sel === null ? (mine !== null ? "SENT ✓" : "SEND") : `${mine === null ? "SEND" : "UPDATE"} ${fmtScore(sel)}`;
}

function startPad() {
  $("#join").classList.add("hidden");
  $("#pad").classList.remove("hidden");
  document.body.classList.add("judge");
  buildKeypad();
  sock = liveSocket({ code, role: "judge", judge: creds.judge, key: creds.pin, onState, onMessage, onStatus });
}

(async function init() {
  if (code) creds = store.get(`judge:${code}`);
  if (!creds) return showJoin();
  try {
    await api(`/api/meets/${code}/auth`, { role: "judge", judge: creds.judge, key: creds.pin });
    startPad();
  } catch (err) {
    if (!err.status) return startPad(); // network blip: the socket keeps retrying
    store.remove(`judge:${code}`);
    showJoin(err.message);
  }
})();
