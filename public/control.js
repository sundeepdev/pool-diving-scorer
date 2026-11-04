// Head referee control for a multi-platform competition. Phase 2: judge
// panels. Seat changes go to the competition straight away and every judge's
// pad follows.
import { $, confirmDialog, esc, liveSocket, store } from "/common.js";
import { heightLabel } from "/ddtable.js";

const code = (new URLSearchParams(location.search).get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
let key = null;
let sock = null;
let state = null;
let ref = 0;

function toast(text, ms = 3000, ok = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("ok", ok);
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), ms);
}

function send(msg) {
  if (sock?.send({ ...msg, ref: ++ref })) return true;
  toast("Offline. Reconnecting…");
  return false;
}

const judgeName = (id) => state.judges.find((j) => j.id === id)?.name ?? "";
const platformName = (id) => state.platforms.find((p) => p.id === id)?.name ?? "";

function seatOf(judgeId) {
  for (const p of state.platforms) {
    const i = (state.panels[p.id] || []).indexOf(judgeId);
    if (i >= 0) return { platformId: p.id, seat: i + 1, active: i < state.sizes[p.id] };
  }
  return null;
}

// ---------- share ----------
function renderShare() {
  const url = `${location.origin}/pad?c=${code}`;
  $("#shareBox").innerHTML = `
    <div class="item"><label>Judge link</label><div class="link mono">${esc(url)}</div>
      <div class="pin">PIN <span class="mono">${esc(state.judgePin)}</span></div>
      <div class="btns"><button class="btn small primary" id="copyJudge">Copy judge invite</button>
      ${navigator.share ? `<button class="btn small" id="shareJudge">Share…</button>` : ""}</div>
      <p class="muted small">Or on the home page: Judge → code <b class="mono">${esc(code)}</b>.</p></div>`;
  const text = `Judge pad for ${state.name}: ${url}  PIN ${state.judgePin}`;
  $("#copyJudge").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(text);
      toast("Judge invite copied", 2000, true);
    } catch {
      prompt("Copy this", text);
    }
  });
  $("#shareJudge")?.addEventListener("click", () => navigator.share({ title: state.name, text }).catch(() => {}));
}

// ---------- judges ----------
function renderJudges() {
  const online = new Set(state.online);
  $("#judgeCount").textContent = state.judges.length ? `(${state.online.length} of ${state.judges.length} online)` : "";
  $("#judgeStatus").innerHTML = state.judges.length
    ? state.judges
        .map((j) => {
          const at = seatOf(j.id);
          const where = at ? `${esc(platformName(at.platformId))} · Seat ${at.seat}${at.active ? "" : " (not used)"}` : "Not on a panel";
          return `<div class="chip judge-chip ${at ? "" : "free"}"><span class="dot ${online.has(j.id) ? "online" : ""}" title="${online.has(j.id) ? "Pad connected" : "Pad not connected"}"></span>
            <span><b>${esc(j.name)}</b><span class="muted small where">${where}</span></span></div>`;
        })
        .join("")
    : `<p class="muted empty-note">No judges yet. Add them on the <a href="/competition?c=${esc(code)}">setup page</a>.</p>`;
}

// ---------- panels ----------
function renderPanels() {
  const online = new Set(state.online);
  if (!state.platforms.length) {
    $("#panels").innerHTML = `<p class="muted empty-note">No platforms yet. Add them on the <a href="/competition?c=${esc(code)}">setup page</a>.</p>`;
    return;
  }
  $("#panels").innerHTML = state.platforms
    .map((p) => {
      const n = state.sizes[p.id];
      const seats = state.panels[p.id] || [];
      const groups = state.groups.filter((g) => g.legs.some((l) => l.platformId === p.id)).map((g) => g.name);
      // Show the seats in use, plus any extra seat that still has someone in it.
      const shown = Math.max(n, ...seats.map((id, i) => (id ? i + 1 : 0)));
      const filled = seats.slice(0, n).filter(Boolean).length;
      const rows = Array.from({ length: shown }, (_, i) => {
        const id = seats[i] || "";
        const opts = state.judges
          .map((j) => {
            const at = seatOf(j.id);
            const elsewhere = at && !(at.platformId === p.id && at.seat === i + 1) ? ` (${platformName(at.platformId)} S${at.seat})` : "";
            return `<option value="${esc(j.id)}" ${j.id === id ? "selected" : ""}>${esc(j.name)}${esc(elsewhere)}</option>`;
          })
          .join("");
        return `<div class="seat-row ${i >= n ? "unused" : ""}">
          <span class="seat-no">${i + 1}</span>
          <select data-plat="${esc(p.id)}" data-seat="${i + 1}" aria-label="${esc(p.name)} seat ${i + 1}"><option value="">— empty —</option>${opts}</select>
          <span class="dot ${id ? (online.has(id) ? "online" : "offline") : ""}" title="${id ? (online.has(id) ? "Pad connected" : "Pad not connected") : ""}"></span>
          ${i >= n ? `<span class="muted small">not used</span>` : ""}
        </div>`;
      }).join("");
      return `<section class="panel-card ${filled === n ? "full" : ""}">
        <div class="panel-head"><h3>${esc(p.name)}</h3><span class="muted small">${esc(heightLabel(p.height))}</span>
          <span class="pill small">${filled}/${n} judges</span></div>
        <p class="muted small" style="margin:4px 0 8px">${groups.length ? `Groups: ${groups.map(esc).join(", ")}` : "No group uses this platform yet"}</p>
        ${rows}
      </section>`;
    })
    .join("");
}

$("#panels").addEventListener("change", (e) => {
  const el = e.target.closest("select[data-plat]");
  if (!el) return;
  send({ type: "seat", platformId: el.dataset.plat, seat: Number(el.dataset.seat), judgeId: el.value || null });
});

$("#fillBtn").addEventListener("click", () => send({ type: "fill" }));
$("#clearBtn").addEventListener("click", async () => {
  if (await confirmDialog("Take every judge off every panel?", { ok: "Clear all", danger: true })) send({ type: "clearPanels" });
});

function render() {
  $("#compName").textContent = state.name;
  document.title = `${state.name} · Control`;
  renderShare();
  renderJudges();
  // Don't rebuild the selects while one is open.
  if (!$("#panels").contains(document.activeElement) || document.activeElement.tagName !== "SELECT") renderPanels();
  else renderPanels.pending = true;
}
$("#panels").addEventListener("focusout", () => {
  if (renderPanels.pending) {
    renderPanels.pending = false;
    setTimeout(renderPanels, 0);
  }
});

// ---------- connection ----------
function setStatus(s) {
  $("#connDot").className = `dot ${s}`;
  $("#connText").textContent = s === "online" ? "Live" : s === "connecting" ? "Connecting" : "Offline";
}

function start(k) {
  key = k;
  $("#codePill").textContent = code;
  $("#setupLink").href = `/competition?c=${code}`;
  sock?.stop();
  sock = liveSocket({
    path: `/api/competitions/${code}/ws`,
    hello: () => ({ type: "hello", role: "referee", key }),
    onStatus: setStatus,
    onState(s) {
      const first = !state;
      state = s;
      if (first) {
        const saved = store.get(`comp:${code}`) || {};
        store.set(`comp:${code}`, { ...saved, key, name: s.name, createdAt: saved.createdAt || Date.now() });
        if (location.hash) history.replaceState(null, "", location.pathname + location.search);
        $("#noKey").classList.add("hidden");
        $("#app").hidden = false;
      }
      render();
    },
    onMessage(msg) {
      if (msg.type === "error" && msg.fatal) {
        sock.stop();
        askKey(msg.message);
      } else if (msg.type === "error") toast(msg.message, 4000);
    },
  });
}

function askKey(msg) {
  $("#compName").textContent = "Competition control";
  $("#app").hidden = true;
  $("#noKey").classList.remove("hidden");
  $("#keyErr").textContent = msg || "";
}

$("#keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  state = null;
  start($("#keyInput").value.trim());
});

if (!code) location.href = "/";
const hashKey = new URLSearchParams(location.hash.slice(1)).get("key");
const initialKey = hashKey || store.get(`comp:${code}`)?.key;
if (initialKey) start(initialKey);
else askKey();
