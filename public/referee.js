import { $, $$, api, confirmDialog, diverById, esc, fmtDD, fmtPts, fmtScore, liveSocket, meetCodeFromUrl, store } from "/common.js";
import { describeDive } from "/dives.js";
import { createSetup } from "/setup.js";

const code = meetCodeFromUrl();
if (!code) location.href = "/";
let key = null;
let sock = null;
let state = null;
let tab = null;

function toast(text, ms = 3000, ok = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("ok", ok);
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), ms);
}

function send(msg) {
  if (sock?.send(msg)) return true;
  toast("Offline — reconnecting…");
  return false;
}

const setup = createSetup({ send, toast, onDirtyChange: (d) => ($("#dirtyDot").hidden = !d) });

// ---------- tabs ----------
function showTab(name) {
  tab = name;
  for (const b of $$("#tabs button")) b.classList.toggle("on", b.dataset.tab === name);
  $("#tab-setup").hidden = name !== "setup";
  $("#tab-run").hidden = name !== "run";
  try {
    sessionStorage.setItem(`tab:${code}`, name);
  } catch {}
}
$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (b) showTab(b.dataset.tab);
});

// ---------- share ----------
const urls = () => ({
  live: `${location.origin}/live?meet=${code}`,
  judge: `${location.origin}/judge?meet=${code}`,
  ref: `${location.origin}/referee?meet=${code}#key=${key}`,
});

function renderShare() {
  const u = urls();
  const html = `<div class="share">
    <div class="item">
      <label>Audience scoreboard</label>
      <div class="link mono">${esc(u.live)}</div>
      <div class="btns">
        <button class="btn small primary" data-copy="live">Copy link</button>
        ${navigator.share ? `<button class="btn small" data-share="live">Share…</button>` : ""}
        <a class="btn small" href="${esc(u.live)}" target="_blank" rel="noopener">Open ↗</a>
      </div>
      <p class="muted small">Send it to spectators, or open it on the big screen. No sign-in needed.</p>
    </div>
    <div class="item">
      <label>Judges</label>
      <div class="link mono">${esc(u.judge)}</div>
      <div class="pin">PIN <span class="mono">${esc(state.judgePin)}</span></div>
      <div class="btns">
        <button class="btn small" data-copy="judge">Copy judge invite</button>
        ${navigator.share ? `<button class="btn small" data-share="judge">Share…</button>` : ""}
      </div>
      <p class="muted small">Connected: ${state.connectedJudges.length}/${state.judges}${
        state.connectedJudges.length ? ` (${state.connectedJudges.map((j) => `J${j}`).join(", ")})` : ""
      }</p>
    </div>
    <div class="item">
      <label>Referee link · keep private</label>
      <div class="btns"><button class="btn small" data-copy="ref">Copy referee link</button></div>
      <p class="muted small">Opens this control panel on another device.</p>
    </div>
  </div>`;
  for (const slot of $$(".share-slot")) slot.innerHTML = html;
}

function shareText(kind) {
  const u = urls();
  const title = [state.name, state.event].filter(Boolean).join(" · ");
  if (kind === "live") return { title, text: `Live diving scores: ${title}`, url: u.live };
  if (kind === "judge") return { title, text: `Judge scoring pad for ${title}\nJudge PIN: ${state.judgePin}`, url: u.judge };
  return { title, text: "Referee control", url: u.ref };
}

document.addEventListener("click", async (e) => {
  const copyBtn = e.target.closest("[data-copy]");
  const shareBtn = e.target.closest("[data-share]");
  if (copyBtn) {
    const { text, url } = shareText(copyBtn.dataset.copy);
    const value = copyBtn.dataset.copy === "judge" ? `${text}\n${url}` : url;
    try {
      await navigator.clipboard.writeText(value);
      toast("Copied to clipboard ✓", 1500, true);
    } catch {
      prompt("Copy this:", value);
    }
  } else if (shareBtn) {
    try {
      await navigator.share(shareText(shareBtn.dataset.share));
    } catch {}
  }
});

// ---------- current dive ----------
function renderCurrent() {
  const c = state.current;
  const card = $("#currentCard");
  if (!state.divers.length) {
    card.innerHTML = `<h2>No divers yet</h2><p class="lead">Add or import the divers first.</p>
      <button class="btn primary" data-goto="setup">Go to Competition setup</button>`;
    return;
  }
  const nx = state.next && diverById(state, state.next.diverId);
  const nextBtn = `<button class="btn primary next" data-act="next" ${nx ? "" : "disabled"}>${
    nx ? `Call next ▶ ${esc(nx.name)} · R${state.next.round + 1}` : "All dives scored"
  } <span style="font-weight:500;font-size:13px;opacity:.6">(N)</span></button>`;

  if (!c) {
    card.innerHTML = `<h2>No dive called</h2><p class="lead">Call the next diver to open the judges' pads.</p>
      <div class="ref-controls">${nextBtn}</div>`;
    return;
  }
  const diver = diverById(state, c.diverId);
  const revealed = c.phase === "revealed";
  const res = revealed ? state.results[`${c.diverId}:${c.round}`] : null;
  const online = new Set(state.connectedJudges);
  const allIn = c.scores.every((v) => v !== null);

  card.innerHTML = `
    <div class="row" style="align-items:baseline">
      <h2 style="flex:1 1 auto">${esc(diver.name)} <span class="muted" style="font-weight:500">${esc(diver.team)}</span></h2>
      <span class="pill" style="flex:none">Round ${c.round + 1}/${state.rounds}</span>
      <span class="pill" style="flex:none;${revealed ? "color:var(--good)" : "color:var(--warn)"}">${revealed ? "Revealed" : "Judging"}</span>
    </div>
    <div class="row" style="margin-top:10px">
      <div class="field"><label for="cCode">Dive</label><input id="cCode" class="mono" value="${esc(c.code)}" placeholder="105B" autocapitalize="characters"></div>
      <div class="field"><label for="cDD">DD</label><input id="cDD" class="mono" inputmode="decimal" value="${c.dd ? c.dd : ""}" placeholder="2.4"></div>
    </div>
    <div class="muted" style="margin:-6px 0 12px;min-height:1.4em">${esc(describeDive(c.code))}</div>
    <div class="tiles" style="--n:${c.scores.length}">${c.scores
      .map((v, i) => {
        const cls = v === null ? "waiting" : res?.dropped.includes(i) ? "dropped" : "in";
        return `<button class="tile ref ${cls}" data-judge="${i + 1}" title="Click to override">
          <span class="conn dot ${online.has(i + 1) ? "online" : "offline"}" title="${online.has(i + 1) ? "Connected" : "Not connected"}"></span>
          <span class="j">J${i + 1}</span><span class="s">${fmtScore(v)}</span></button>`;
      })
      .join("")}</div>
    ${res ? `<p style="font-size:18px;margin:14px 0 0">${res.failed ? '<b style="color:var(--bad)">FAILED DIVE</b> · ' : ""}
      Sum ${res.sum.toFixed(1)} × DD ${fmtDD(res.dd)} = <b class="mono" style="font-size:28px;color:var(--gold)">${fmtPts(res.award)}</b></p>` : ""}
    <div class="ref-controls">
      ${revealed
        ? `<button class="btn" data-act="reopen">Re-open scoring</button>`
        : `<button class="btn good" data-act="reveal" ${allIn ? "" : "disabled"}>Reveal (R)</button>
           <button class="btn danger" data-act="failed">Failed dive</button>`}
      <button class="btn" data-act="clear">Cancel call</button>
      ${nextBtn}
    </div>`;
}

$("#currentCard").addEventListener("click", async (e) => {
  const go = e.target.closest("[data-goto]");
  if (go) return showTab(go.dataset.goto);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "failed" && !(await confirmDialog("Score this as a failed dive (0 points)?", { ok: "Failed dive", danger: true }))) return;
  if (act === "next" && state.current?.phase === "scoring" && !(await confirmDialog("Current dive hasn't been revealed. Move on anyway?", { ok: "Move on" }))) return;
  if (act) return send({ type: act });
  const tile = e.target.closest("[data-judge]");
  if (tile) openScoreDialog(Number(tile.dataset.judge));
});

$("#currentCard").addEventListener("change", (e) => {
  if (e.target.id === "cCode") send({ type: "setDive", code: e.target.value.trim() });
  if (e.target.id === "cDD") send({ type: "setDive", dd: Number(e.target.value) });
});

document.addEventListener("keydown", (e) => {
  if (tab !== "run" || e.target.closest("input, textarea, select, dialog") || e.metaKey || e.ctrlKey) return;
  if (e.key === "n" || e.key === "N") $('[data-act="next"]:not(:disabled)')?.click();
  if (e.key === "r" || e.key === "R") $('[data-act="reveal"]:not(:disabled)')?.click();
});

// ---------- score override dialog ----------
let dlgJudge = 0;
$("#dlgGrid").innerHTML = Array.from({ length: 21 }, (_, i) => `<button class="btn" data-v="${i / 2}">${fmtScore(i / 2)}</button>`).join("");
function openScoreDialog(j) {
  if (state.current.phase !== "scoring") return toast("Re-open scoring to change a score");
  dlgJudge = j;
  $("#dlgTitle").textContent = `Set score for Judge ${j}`;
  $("#scoreDlg").showModal();
}
$("#dlgGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  send({ type: "setScore", judge: dlgJudge, value: Number(b.dataset.v) });
  $("#scoreDlg").close();
});
$("#dlgClear").addEventListener("click", () => {
  send({ type: "setScore", judge: dlgJudge, value: null });
  $("#scoreDlg").close();
});
$("#dlgCancel").addEventListener("click", () => $("#scoreDlg").close());

// ---------- running order ----------
function renderOrder() {
  const c = state.current;
  const totals = Object.fromEntries(state.standings.map((s) => [s.diverId, s]));
  const head = `<tr><th>Diver</th>${Array.from({ length: state.rounds }, (_, r) => `<th>R${r + 1}</th>`).join("")}<th>Total</th></tr>`;
  const rows = state.divers
    .map((d) => {
      const cells = Array.from({ length: state.rounds }, (_, r) => {
        const res = state.results[`${d.id}:${r}`];
        const dive = res || d.dives[r];
        const cur = c && c.diverId === d.id && c.round === r;
        return `<td class="slot ${res ? "done" : ""} ${cur ? "cur" : ""}" data-diver="${d.id}" data-round="${r}">
          <span class="c">${dive?.code ? `${esc(dive.code)} · ${fmtDD(dive.dd)}` : "—"}</span>${res ? `<b>${fmtPts(res.award)}</b>` : "&nbsp;"}</td>`;
      }).join("");
      const t = totals[d.id];
      return `<tr><td><b>${esc(d.name)}</b><br><span class="muted">${esc(d.team)}</span></td>${cells}<td><b class="mono">${fmtPts(t?.total)}</b><br><span class="muted">#${t?.done ? t.rank : "–"}</span></td></tr>`;
    })
    .join("");
  $("#order").innerHTML = head + (rows || `<tr><td class="muted" colspan="99">No divers yet.</td></tr>`);
}

$("#order").addEventListener("click", async (e) => {
  const cell = e.target.closest("[data-diver]");
  if (!cell) return;
  const c = state.current;
  if (c && c.phase === "scoring" && c.scores.some((v) => v !== null) && !(await confirmDialog("Scores for the current dive haven't been revealed. Switch anyway?", { ok: "Switch" }))) return;
  send({ type: "call", diverId: cell.dataset.diver, round: Number(cell.dataset.round) });
});

$("#csvBtn").addEventListener("click", () => {
  const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
  const lines = [["Rank", "Diver", "Team", "Round", "Dive", "Description", "DD", ...Array.from({ length: state.judges }, (_, i) => `J${i + 1}`), "Points", "Failed", "Total"].map(q).join(",")];
  for (const s of state.standings) {
    const d = diverById(state, s.diverId);
    for (let r = 0; r < state.rounds; r++) {
      const res = state.results[`${d.id}:${r}`];
      if (!res) continue;
      const scores = Array.from({ length: state.judges }, (_, i) => res.scores[i] ?? "");
      lines.push([s.rank, d.name, d.team, r + 1, res.code, describeDive(res.code), res.dd, ...scores, fmtPts(res.award), res.failed ? "yes" : "", fmtPts(s.total)].map(q).join(","));
    }
  }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n")], { type: "text/csv" }));
  a.download = `${state.name.replace(/[^\w-]+/g, "_")}_${code}_results.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- wiring ----------
function render() {
  document.title = `${state.name} · Referee`;
  $("#meetName").textContent = [state.name, state.event].filter(Boolean).join(" · ");
  const active = document.activeElement?.id;
  if (active !== "cCode" && active !== "cDD") renderCurrent();
  renderOrder();
  if (!document.activeElement?.closest(".share-slot")) renderShare();
}

function onStatus(status) {
  $("#connDot").className = `dot ${status}`;
  $("#connText").textContent = status === "online" ? "Live" : status === "connecting" ? "Connecting" : "Offline";
}

async function start(k) {
  await api(`/api/meets/${code}/auth`, { role: "referee", key: k });
  key = k;
  const saved = store.get(`ref:${code}`) || {};
  store.set(`ref:${code}`, { ...saved, key, createdAt: saved.createdAt || Date.now() });
  $("#noKey").classList.add("hidden");
  $("#app").hidden = false;
  $("#tabs").hidden = false;
  $("#codePill").textContent = code;
  $("#liveLink").href = urls().live;
  sock = liveSocket({
    code,
    role: "referee",
    key,
    onState: (s) => {
      const first = !state;
      state = s;
      store.set(`ref:${code}`, { ...store.get(`ref:${code}`), name: s.name });
      if (first) {
        let saved = null;
        try {
          saved = sessionStorage.getItem(`tab:${code}`);
        } catch {}
        showTab(saved || (s.divers.length ? "run" : "setup"));
      }
      setup.onState(s);
      render();
    },
    onMessage: (m) => {
      if (m.type === "ack") setup.onAck(m.ref);
      else if (m.type === "error" && !setup.onError(m)) toast(m.message);
    },
    onStatus,
  });
}

function askForKey(msg) {
  $("#noKey").classList.remove("hidden");
  $("#keyErr").textContent = msg || "";
  $("#meetName").textContent = `Meet ${code}`;
}
$("#keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  start($("#keyInput").value.trim()).catch((err) => ($("#keyErr").textContent = err.message));
});

const hashKey = new URLSearchParams(location.hash.slice(1)).get("key");
if (hashKey) history.replaceState(null, "", location.pathname + location.search);
const initialKey = hashKey || store.get(`ref:${code}`)?.key;
if (initialKey) start(initialKey).catch((err) => askForKey(err.message));
else askForKey();
