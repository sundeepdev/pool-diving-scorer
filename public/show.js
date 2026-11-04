// Audience scoreboard for a multi-platform competition. No sign-in.
//   /show?c=CODE        every platform at a glance, plus standings per group
//   /show?c=CODE&p=ID   one platform, big, for the screen by that pool
import { $, esc, fmtDD, fmtPts, fmtScore, liveSocket, ordinal } from "/common.js";
import { describeDive } from "/dives.js";

const params = new URLSearchParams(location.search);
const code = (params.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
let view = params.get("p") || "all";
let state = null;
const animated = new Map(); // platformId → seq:award already flipped
const expanded = new Set();

if (!code) location.href = "/";

$("#fsBtn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

$("#viewSel").addEventListener("change", (e) => {
  view = e.target.value;
  const q = new URLSearchParams({ c: code });
  if (view !== "all") q.set("p", view);
  history.replaceState(null, "", `/show?${q}`);
  render();
});

$("#main").addEventListener("click", (e) => {
  const row = e.target.closest("[data-diver]");
  if (!row) return;
  const id = row.dataset.diver;
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  render();
});

const diverById = (id) => state.divers.find((d) => d.id === id);
const groupById = (id) => state.groups.find((g) => g.id === id);
const standingOf = (groupId, diverId) => (state.standings[groupId] || []).find((s) => s.diverId === diverId);

// ---------- one platform, big ----------
function stageHtml(p, { compact = false } = {}) {
  const g = groupById(p.groupId);
  const c = p.current;
  const nx = p.next && diverById(p.next.diverId);
  const upNext =
    nx && (!c || c.phase === "revealed") ? `<div class="upnext">Up next: <b>${esc(nx.name)}</b>${nx.team ? ` · ${esc(nx.team)}` : ""} · dive ${p.next.round + 1}</div>` : "";
  const head = `<div class="label">${esc(p.name)}${g ? ` · ${esc(g.name)}` : ""}</div>`;
  if (!g) return `${head}<div class="name">Waiting</div><div class="team">No group on this platform yet</div>`;
  if (!c) {
    const done = p.progress && p.progress.total && p.progress.done === p.progress.total;
    return `${head}<div class="name">${done ? `${esc(g.name)} finished here` : "Next diver coming up"}</div>
      <div class="team">${p.progress ? `${p.progress.done}/${p.progress.total} dives on ${esc(p.name)}` : ""}</div>${upNext}`;
  }
  const diver = diverById(c.diverId);
  const revealed = c.phase === "revealed";
  const res = revealed ? state.results[`${c.diverId}:${c.round}`] : null;
  const key = `${c.seq}:${res?.award}`;
  const animate = revealed && !compact && animated.get(p.id) !== key;
  if (revealed) animated.set(p.id, key);
  const st = standingOf(g.id, c.diverId);
  const inCount = c.submitted.filter(Boolean).length;
  const tiles = c.submitted
    .map((isIn, i) => {
      if (revealed && res) {
        const cls = res.dropped.includes(i) ? "dropped" : "in";
        return `<div class="tile ${cls} ${animate ? "flip" : ""}" style="--i:${i}"><div class="j">J${i + 1}</div><div class="s">${fmtScore(c.scores[i])}</div></div>`;
      }
      return `<div class="tile ${isIn ? "in" : "waiting"}"><div class="j">J${i + 1}</div><div class="s ${isIn ? "" : "pulse"}">${isIn ? "✓" : "•"}</div></div>`;
    })
    .join("");
  return `${head}
    <div class="label" style="color:var(--muted)">${revealed ? "Result" : `Now diving · judges ${inCount}/${c.submitted.length}`} · dive ${c.round + 1}/${g.plan.length}</div>
    <div class="name">${esc(diver?.name)}</div>
    <div class="team">${esc(diver?.team || "")}</div>
    <div class="dive-line">
      ${c.code ? `<span class="dive-code">${esc(c.code)}</span>` : ""}
      <span class="dive-desc">${esc(describeDive(c.code))}</span>
      <span class="dd">DD <b>${fmtDD(c.dd)}</b> · ${esc(c.height)}m</span>
    </div>
    <div class="tiles" style="--n:${c.submitted.length}">${tiles}</div>
    ${res?.failed ? `<div class="failed-tag">FAILED DIVE</div>` : ""}
    ${res ? `<div class="result">
        <div class="box hl"><div class="k">Dive points</div><div class="v">${fmtPts(res.award)}</div></div>
        <div class="box"><div class="k">Total</div><div class="v">${fmtPts(st?.total)}</div></div>
        <div class="box"><div class="k">Position</div><div class="v">${st ? ordinal(st.rank) : "–"}</div></div>
      </div>` : ""}
    ${upNext}`;
}

function standingsHtml(groupId, currentDiverId) {
  const g = groupById(groupId);
  if (!g) return "";
  const rows = (state.standings[groupId] || [])
    .map((row) => {
      const d = diverById(row.diverId);
      const open = expanded.has(row.diverId);
      const dives = g.plan
        .map((slot, r) => {
          const res = state.results[`${row.diverId}:${r}`];
          return res ? `<span title="${esc(describeDive(res.code))}">${r + 1}. ${esc(res.code)} ${esc(res.height)}m ${fmtPts(res.award)}</span>` : "";
        })
        .join("");
      return `<tr class="diver-row ${row.diverId === currentDiverId ? "now" : ""}" data-diver="${esc(row.diverId)}" aria-expanded="${open}">
        <td class="rk">${row.done ? row.rank : "–"}</td>
        <td class="nm">${esc(d.name)}<small>${esc(d.team)}</small></td>
        <td class="tot">${fmtPts(row.total)}<small>${row.done}/${row.rounds} dives</small></td>
      </tr>${open ? `<tr class="detail"><td></td><td colspan="2"><div class="mini">${dives || "<span>No dives yet</span>"}</div></td></tr>` : ""}`;
    })
    .join("");
  return `<h3>${esc(g.name)}</h3><table class="standings"><tbody>${rows || `<tr><td class="muted">No divers</td></tr>`}</tbody></table>`;
}

function renderPlatform(p) {
  $("#main").className = "live-grid";
  $("#main").innerHTML = `<section class="stage" aria-live="polite">${stageHtml(p)}</section>
    <aside class="board">${p.groupId ? standingsHtml(p.groupId, p.current?.diverId) : `<h3>Standings</h3><p class="muted">No group on this platform yet.</p>`}</aside>`;
}

// ---------- every platform ----------
function renderAll() {
  $("#main").className = "show-all";
  const now = new Set(state.platforms.map((p) => p.current?.diverId).filter(Boolean));
  const active = state.platforms.filter((p) => p.groupId);
  const idle = state.platforms.filter((p) => !p.groupId);
  $("#main").innerHTML = `
    <div class="show-platforms">${
      active.map((p) => `<section class="stage compact"><a class="open-plat" href="/show?c=${esc(code)}&p=${esc(p.id)}" title="Show only ${esc(p.name)}">⤢</a>${stageHtml(p, { compact: true })}</section>`).join("") ||
      `<section class="stage compact"><div class="label">${esc(state.name)}</div><div class="name">Starting soon</div></section>`
    }</div>
    ${idle.length && active.length ? `<p class="muted small" style="margin:0 16px">Not in use right now: ${idle.map((p) => esc(p.name)).join(", ")}</p>` : ""}
    <div class="show-boards">${state.groups
      .map((g) => `<aside class="board">${standingsHtml(g.id, [...now].find((id) => diverById(id)?.groupId === g.id))}</aside>`)
      .join("")}</div>`;
}

function render() {
  document.title = `${state.name} · Live`;
  $("#compName").textContent = state.name;
  const sel = $("#viewSel");
  sel.innerHTML = `<option value="all">All platforms</option>${state.platforms.map((p) => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join("")}`;
  if (!state.platforms.some((p) => p.id === view)) view = "all";
  sel.value = view;
  if (view === "all") renderAll();
  else renderPlatform(state.platforms.find((p) => p.id === view));
}

function onStatus(status) {
  $("#connDot").className = `dot ${status}`;
  $("#connText").textContent = status === "online" ? "LIVE" : status === "connecting" ? "Connecting" : "Offline";
}

fetch(`/api/competitions/${code}`).then((res) => {
  if (!res.ok) {
    $("#compName").textContent = res.status === 404 ? `Competition ${code} not found` : "Couldn't load the competition";
    return;
  }
  liveSocket({
    path: `/api/competitions/${code}/ws`,
    hello: () => ({ type: "hello", role: "audience" }),
    onStatus,
    onState(s) {
      state = s;
      render();
    },
  });
});
