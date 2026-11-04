// Judge pad for a multi-platform competition. The judge signs in with the
// PIN and taps their name. Until a group is diving on their platform they see
// the platform and seat the referee gave them; then they score each dive on
// the keypad. The pad follows when the referee moves them. The judge in seat 1
// (chief judge) can also change the dive before it's revealed.
import { $, esc, fmtDD, fmtPts, fmtScore, liveSocket, store } from "/common.js";
import { heightLabel } from "/ddtable.js";
import { describeDive } from "/dives.js";

const clean = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
let code = clean(new URLSearchParams(location.search).get("c"));
let creds = code ? store.get(`pad:${code}`) : null; // { pin, judgeId }
let sock = null;
let state = null;
let online = false;
let lastSeat = null;
let lastSeq = null;
let whole = null; // selected whole number, or null
let half = false;
let pending = null; // { seq, value, ref } sent but not yet acknowledged
let ref = 0;

const selection = () => (whole === null ? null : whole + (half ? 0.5 : 0));
const buzz = (ms) => navigator.vibrate?.(ms);

function toast(text, ms = 2500, ok = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("ok", ok);
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), ms);
}

function show(id) {
  for (const s of ["join", "pick", "pad"]) $(`#${s}`).classList.toggle("hidden", s !== id);
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
function showJoin(message) {
  sock?.stop();
  sock = null;
  show("join");
  $("#joinCode").value = code;
  $("#joinErr").textContent = message || "";
  (code ? $("#joinPin") : $("#joinCode")).focus();
}

$("#joinCode").addEventListener("input", (e) => (e.target.value = clean(e.target.value)));
$("#joinForm").addEventListener("submit", (e) => {
  e.preventDefault();
  code = clean($("#joinCode").value);
  history.replaceState(null, "", `/pad?c=${code}`);
  creds = { pin: $("#joinPin").value.trim(), judgeId: null };
  connect();
});

function showPicker(msg) {
  show("pick");
  $("#pickTitle").textContent = `${msg.name}: who are you?`;
  $("#names").innerHTML = msg.judges.length
    ? msg.judges.map((j) => `<button class="btn name-btn" data-id="${esc(j.id)}">${esc(j.name)}</button>`).join("")
    : `<p class="muted">No judges have been added yet.</p>`;
}

$("#names").addEventListener("click", (e) => {
  const b = e.target.closest("[data-id]");
  if (!b) return;
  creds.judgeId = b.dataset.id;
  store.set(`pad:${code}`, creds);
  sock.send({ type: "hello", role: "judge", ...creds });
});

$("#notMeBtn").addEventListener("click", () => {
  creds = { pin: creds.pin, judgeId: null };
  store.set(`pad:${code}`, creds);
  state = null;
  lastSeat = null;
  sock.send({ type: "hello", role: "judge", pin: creds.pin });
});

// ---------- keypad ----------
$("#keypad").innerHTML =
  [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => `<button class="key" data-n="${n}" aria-label="${n}">${n}</button>`).join("") +
  `<button class="key half" data-half aria-label="plus one half">+½</button>`;

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

const canScore = () => !!(state?.scoring && state.current?.phase === "scoring");

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
    const mine = state.current.myScore;
    if (mine === null || mine === undefined) return;
    whole = Math.floor(mine);
    half = mine % 1 === 0;
  } else half = !half;
  if (whole === 10) half = false;
  buzz(8);
  render();
}

function sendScore() {
  const value = selection();
  if (value === null || !canScore()) return;
  const seq = state.current.seq;
  pending = { seq, value, ref: ++ref };
  whole = null;
  half = false;
  if (!sock.send({ type: "score", seq, value, ref: pending.ref })) toast("Offline. Your score will be sent when you're back online.");
  buzz(25);
  render();
}
$("#sendBtn").addEventListener("click", sendScore);

// Keyboard: digits, "10" (type 1 then 0), "." or "h" for half, Enter to send, Esc/Backspace to clear.
let lastKey = { key: null, at: 0 };
document.addEventListener("keydown", (e) => {
  if ($("#pad").classList.contains("hidden") || e.target.closest("dialog, input") || e.metaKey || e.ctrlKey || e.altKey) return;
  const now = Date.now();
  if (/^[0-9]$/.test(e.key)) {
    if (e.key === "0" && lastKey.key === "1" && now - lastKey.at < 800 && whole === 1) pick(10);
    else pick(Number(e.key));
  } else if ([".", ",", "h", "H", "+"].includes(e.key)) toggleHalf();
  else if (e.key === "Enter") sendScore();
  else if (e.key === "Escape" || e.key === "Backspace") {
    whole = null;
    half = false;
    render();
  } else return;
  e.preventDefault();
  lastKey = { key: e.key, at: now };
});

// ---------- chief judge: change the dive ----------
function openDiveDialog() {
  const c = state.current;
  $("#diveDlgWho").textContent = `${c.diverName} · dive ${c.round + 1} · ${c.height}m`;
  $("#diveOptions").innerHTML = c.options
    .map((o) => `<button type="button" class="btn ${o === c.code ? "primary" : ""}" data-dive="${esc(o)}"><b class="mono">${esc(o)}</b><br><span class="small">${esc(describeDive(o))}</span></button>`)
    .join("");
  $("#dCode").value = c.code;
  $("#dDD").value = "";
  $("#diveDlg").showModal();
}
$("#diveOptions").addEventListener("click", (e) => {
  const b = e.target.closest("[data-dive]");
  if (!b) return;
  $("#dCode").value = b.dataset.dive;
  for (const x of $("#diveOptions").children) x.classList.toggle("primary", x === b);
});
$("#dCode").addEventListener("input", (e) => (e.target.value = e.target.value.toUpperCase()));
$("#diveDlg").addEventListener("close", () => {
  if ($("#diveDlg").returnValue !== "ok") return;
  const dd = $("#dDD").value.trim().replace(",", ".");
  sock.send({ type: "setDive", code: $("#dCode").value.trim(), dd: dd === "" ? null : Number(dd), ref: ++ref });
});

// ---------- render ----------
function renderAssign() {
  const { seat } = state;
  let html;
  if (!seat) {
    html = `<div class="assign-wait"><h2>Not on a panel yet</h2><p>The referee will put you on a platform. This screen updates by itself.</p></div>`;
  } else {
    const groupLine = state.group
      ? state.scoring
        ? `<p style="margin-top:14px"><b>${esc(state.group.name)}</b> is on this platform.</p>`
        : `<p class="warn-text" style="margin-top:14px">${esc(state.group.name)} uses ${state.group.panel} judges, so seat ${seat.seat} doesn't score for this group. Stay ready.</p>`
      : seat.groups.length
        ? `<p class="muted" style="margin-top:14px">Groups on this platform: ${seat.groups.map(esc).join(", ")}</p>`
        : "";
    html = `<div class="assign-card ${seat.active ? "" : "inactive"}">
      <div class="label">Your platform</div>
      <div class="plat">${esc(seat.platformName)}</div>
      <div class="muted">${esc(heightLabel(seat.height))}</div>
      <div class="label" style="margin-top:18px">Your seat</div>
      <div class="seatno">${seat.seat}<span class="muted"> of ${seat.size}</span></div>
      ${seat.active ? "" : `<p class="warn-text">Seat ${seat.seat} isn't used on this platform at the moment. Wait for the referee.</p>`}
      ${groupLine}
      ${state.group && state.scoring ? `<p class="muted small" style="margin-top:18px">Waiting for the referee to call the first diver…</p>` : ""}
    </div>`;
  }
  $("#assign").innerHTML = html;
}

function renderScoring() {
  const c = state.current;
  const s = state.seat;
  const scoring = c.phase === "scoring";
  const revealed = c.phase === "revealed";
  const sel = selection();
  const mine = c.myScore;

  $("#diveCard").innerHTML = `<div class="row" style="align-items:center;gap:8px"><span class="seatline">${esc(s.platformName)} · Seat ${s.seat} · ${esc(state.group.name)}</span>
      ${state.canEditDive && scoring ? `<button class="btn small edit-dive" id="editDive">Change dive</button>` : ""}</div>
    <div class="who">${esc(c.diverName)}</div>
    <div class="meta"><span>Dive <b>${c.round + 1}</b>/${state.group.rounds}</span>${c.team ? `<span>${esc(c.team)}</span>` : ""}
      <span><b class="mono">${esc(c.code || "—")}</b> ${esc(describeDive(c.code))}</span><span>DD <b class="mono">${fmtDD(c.dd)}</b></span></div>`;
  $("#editDive")?.addEventListener("click", openDiveDialog);

  const ro = $("#readout");
  ro.classList.toggle("sent", scoring && sel === null && !pending && mine !== null);
  ro.classList.toggle("pending", !!pending);
  let value = "–";
  let status = "";
  if (pending) {
    value = fmtScore(pending.value);
    status = online ? "Sending…" : "Queued. Offline";
  } else if (sel !== null) {
    value = fmtScore(sel);
    status = mine === null ? "Tap SEND" : `Sent ${fmtScore(mine)} · tap UPDATE`;
  } else if (mine !== null && mine !== undefined) {
    value = fmtScore(mine);
    status = revealed ? "Locked" : "Sent ✓ · tap a number to change";
  } else status = scoring ? "Enter your score" : "";
  $("#readValue").textContent = value;
  $("#readStatus").textContent = status;

  $("#keypad").classList.toggle("hidden", !scoring);
  $("#padWait").classList.toggle("hidden", scoring);
  if (scoring) {
    for (const k of $("#keypad").children) {
      if (k.dataset.half !== undefined) {
        k.classList.toggle("on", half);
        k.disabled = whole === 10 || (whole === null && (mine === null || mine === 10));
      } else k.classList.toggle("sel", Number(k.dataset.n) === whole);
    }
  } else {
    $("#padWait").innerHTML = `<div style="width:100%">
      <h2>${c.failed ? "Failed dive" : "Scores in"}</h2>
      <div class="tiles" style="--n:${c.scores.length};margin:12px 0">${c.scores
        .map((v, i) => `<div class="tile ${c.dropped.includes(i) ? "dropped" : "in"}"><div class="j">S${i + 1}${i + 1 === s.seat ? " · YOU" : ""}</div><div class="s">${fmtScore(v)}</div></div>`)
        .join("")}</div>
      <div style="font-size:22px">Award <b class="mono" style="font-size:34px;color:var(--gold)">${fmtPts(c.award)}</b></div>
      <p>${state.next ? `Up next: <b>${esc(state.next.diverName)}</b> · dive ${state.next.round + 1}` : "Waiting for the referee…"}</p></div>`;
  }

  const btn = $("#sendBtn");
  btn.disabled = !scoring || sel === null || !!pending;
  btn.textContent = !scoring ? "LOCKED" : sel === null ? (mine !== null ? "SENT ✓" : "SEND") : `${mine === null ? "SEND" : "UPDATE"} ${fmtScore(sel)}`;
}

function render() {
  show("pad");
  const { me, seat } = state;
  $("#compName").textContent = state.name;
  $("#mePill").textContent = me?.name ?? "–";
  document.title = `${me?.name ?? "Judge"} · ${state.name}`;
  const scoringView = !!(state.scoring && state.current);
  $("#assign").classList.toggle("hidden", scoringView);
  $("#scorePad").classList.toggle("hidden", !scoringView);
  $(".pad-main").classList.toggle("assign-mode", !scoringView);
  if (scoringView) renderScoring();
  else renderAssign();

  const now = seat ? `${seat.platformId}:${seat.seat}` : "";
  if (lastSeat !== null && now !== lastSeat) {
    buzz([60, 40, 60]);
    toast(seat ? `You're now on ${seat.platformName}, seat ${seat.seat}` : "You've been taken off the panel", 4000, true);
    $("#assign .assign-card, #assign .assign-wait")?.classList.add("flash");
  }
  lastSeat = now;
}

function onState(s) {
  if (!s.me) {
    // Removed from the judge list: pick again.
    creds.judgeId = null;
    store.set(`pad:${code}`, creds);
    return sock.send({ type: "hello", role: "judge", pin: creds.pin });
  }
  state = s;
  const seq = s.current?.seq ?? null;
  if (seq !== lastSeq) {
    if (seq !== null && s.current.phase === "scoring" && lastSeq !== null && s.scoring) buzz([40, 60, 40]);
    lastSeq = seq;
    whole = null;
    half = false;
    if (pending && pending.seq !== seq) pending = null;
  }
  if (pending && s.current?.myScore === pending.value) pending = null;
  render();
}

// ---------- connection ----------
function setStatus(st) {
  online = st === "online";
  $("#connDot").className = `dot ${st}`;
  $("#connText").textContent = st === "online" ? "Live" : st === "connecting" ? "Connecting" : "Offline";
  $("#offlineBanner").classList.toggle("hidden", st !== "offline" || !state);
}

function connect() {
  sock?.stop();
  state = null;
  sock = liveSocket({
    path: `/api/competitions/${code}/ws`,
    hello: () => ({ type: "hello", role: "judge", ...creds }),
    onStatus(st) {
      setStatus(st);
      // A score queued while offline is re-sent once signed in again (after the state arrives).
    },
    onState(s) {
      const resend = pending && s.current?.myScore == null && s.current?.seq === pending.seq && s.current.phase === "scoring";
      onState(s);
      if (resend) sock.send({ type: "score", seq: pending.seq, value: pending.value, ref: pending.ref });
    },
    onMessage(msg) {
      if (msg.type === "chooseJudge") {
        store.set(`pad:${code}`, creds);
        showPicker(msg);
      } else if (msg.type === "ack" && pending && msg.ref === pending.ref) {
        pending = null;
        if (state) render();
      } else if (msg.type === "replaced") {
        sock.stop();
        show("pad");
        $("#assign").classList.remove("hidden");
        $("#scorePad").classList.add("hidden");
        $(".pad-main").classList.add("assign-mode");
        $("#assign").innerHTML = `<div class="assign-wait"><h2>Signed in on another device</h2>
          <p>${esc(state?.me?.name ?? "This judge")} is now using another phone or tablet.</p>
          <button class="btn primary" id="takeBack">Use this device instead</button></div>`;
        $("#takeBack").addEventListener("click", connect);
        setStatus("offline");
      } else if (msg.type === "error" && msg.fatal) {
        store.remove(`pad:${code}`);
        showJoin(msg.message);
      } else if (msg.type === "error") {
        if (pending && msg.ref === pending.ref) pending = null;
        toast(msg.message);
        if (state) render();
      }
    },
  });
}

if (code && creds?.pin) connect();
else showJoin();
