// Judge pad for a multi-platform competition. Phase 2: the judge signs in
// with the PIN, taps their name, and sees the platform and seat the referee
// gave them. The pad follows when the referee moves them. Scoring is added in
// the next phase.
import { $, esc, liveSocket, store } from "/common.js";
import { heightLabel } from "/ddtable.js";

const clean = (v) => String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
let code = clean(new URLSearchParams(location.search).get("c"));
let creds = code ? store.get(`pad:${code}`) : null; // { pin, judgeId }
let sock = null;
let state = null;
let lastSeat = null;

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

// ---------- assignment ----------
function render() {
  show("pad");
  const { me, seat } = state;
  $("#compName").textContent = state.name;
  $("#mePill").textContent = me?.name ?? "–";
  document.title = `${me?.name ?? "Judge"} · ${state.name}`;
  let html;
  if (!seat) {
    html = `<div class="assign-wait"><h2>Not on a panel yet</h2><p>The referee will put you on a platform. This screen updates by itself.</p></div>`;
  } else {
    html = `<div class="assign-card ${seat.active ? "" : "inactive"}">
      <div class="label">Your platform</div>
      <div class="plat">${esc(seat.platformName)}</div>
      <div class="muted">${esc(heightLabel(seat.height))}</div>
      <div class="label" style="margin-top:18px">Your seat</div>
      <div class="seatno">${seat.seat}<span class="muted"> of ${seat.size}</span></div>
      ${seat.active ? "" : `<p class="warn-text">Seat ${seat.seat} isn't used on this platform at the moment. Wait for the referee.</p>`}
      ${seat.groups.length ? `<p class="muted" style="margin-top:14px">Groups on this platform: ${seat.groups.map(esc).join(", ")}</p>` : ""}
      <p class="muted small" style="margin-top:18px">Scoring opens here when the competition starts.</p>
    </div>`;
  }
  $("#assign").innerHTML = html;
  const now = seat ? `${seat.platformId}:${seat.seat}` : "";
  if (lastSeat !== null && now !== lastSeat) {
    buzz([60, 40, 60]);
    toast(seat ? `You're now on ${seat.platformName}, seat ${seat.seat}` : "You've been taken off the panel", 4000, true);
    $("#assign .assign-card, #assign .assign-wait")?.classList.add("flash");
  }
  lastSeat = now;
}

// ---------- connection ----------
function setStatus(s) {
  $("#connDot").className = `dot ${s}`;
  $("#connText").textContent = s === "online" ? "Live" : s === "connecting" ? "Connecting" : "Offline";
  $("#offlineBanner").classList.toggle("hidden", s !== "offline" || !state);
}

function connect() {
  sock?.stop();
  state = null;
  sock = liveSocket({
    path: `/api/competitions/${code}/ws`,
    hello: () => ({ type: "hello", role: "judge", ...creds }),
    onStatus: setStatus,
    onState(s) {
      if (!s.me) {
        // Removed from the judge list: pick again.
        creds.judgeId = null;
        store.set(`pad:${code}`, creds);
        return sock.send({ type: "hello", role: "judge", pin: creds.pin });
      }
      state = s;
      render();
    },
    onMessage(msg) {
      if (msg.type === "chooseJudge") {
        store.set(`pad:${code}`, creds);
        showPicker(msg);
      } else if (msg.type === "replaced") {
        sock.stop();
        show("pad");
        $("#assign").innerHTML = `<div class="assign-wait"><h2>Signed in on another device</h2>
          <p>${esc(state?.me?.name ?? "This judge")} is now using another phone or tablet.</p>
          <button class="btn primary" id="takeBack">Use this device instead</button></div>`;
        $("#takeBack").addEventListener("click", connect);
        setStatus("offline");
      } else if (msg.type === "error" && msg.fatal) {
        store.remove(`pad:${code}`);
        showJoin(msg.message);
      } else if (msg.type === "error") toast(msg.message);
    },
  });
}

if (code && creds?.pin) connect();
else showJoin();
