import { $, api, diverById, esc, fmtDD, fmtPts, fmtScore, liveSocket, meetCodeFromUrl, ordinal } from "/common.js";
import { describeDive } from "/dives.js";

const code = meetCodeFromUrl();
let state = null;
let animatedSeq = null;
const expanded = new Set();

if (!code) location.href = "/";

$("#fsBtn").addEventListener("click", () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen?.();
});

$("#standings").addEventListener("click", (e) => {
  const row = e.target.closest("[data-diver]");
  if (!row) return;
  const id = row.dataset.diver;
  expanded.has(id) ? expanded.delete(id) : expanded.add(id);
  renderStandings();
});

function standingFor(id) {
  return state.standings.find((s) => s.diverId === id);
}

function renderStage() {
  const c = state.current;
  const stage = $("#stage");
  const nx = state.next && diverById(state, state.next.diverId);
  const upNext = nx && (!c || c.phase === "revealed")
    ? `<div class="upnext">Up next: <b>${esc(nx.name)}</b>${nx.team ? ` · ${esc(nx.team)}` : ""} · round ${state.next.round + 1}</div>`
    : "";

  if (!c) {
    const done = state.divers.length && !state.next;
    stage.innerHTML = `<div class="label">${done ? "Competition complete" : "Waiting"}</div>
      <div class="name">${done ? "Final results" : "Next diver coming up"}</div>
      <div class="team">${esc(state.name)}</div>${upNext}`;
    return;
  }

  const diver = diverById(state, c.diverId);
  const revealed = c.phase === "revealed";
  const res = revealed ? state.results[`${c.diverId}:${c.round}`] : null;
  const animate = revealed && animatedSeq !== `${c.seq}:${res?.award}`;
  if (revealed) animatedSeq = `${c.seq}:${res?.award}`;
  const st = standingFor(c.diverId);
  const inCount = c.submitted.filter(Boolean).length;

  const tiles = c.submitted
    .map((isIn, i) => {
      if (revealed) {
        const cls = res.dropped.includes(i) ? "dropped" : "in";
        return `<div class="tile ${cls} ${animate ? "flip" : ""}" style="--i:${i}"><div class="j">J${i + 1}</div><div class="s">${fmtScore(c.scores[i])}</div></div>`;
      }
      return `<div class="tile ${isIn ? "in" : "waiting"}"><div class="j">J${i + 1}</div><div class="s ${isIn ? "" : "pulse"}">${isIn ? "✓" : "•"}</div></div>`;
    })
    .join("");

  stage.innerHTML = `
    <div class="label">${revealed ? "Result" : `Now diving · judges ${inCount}/${c.submitted.length}`}</div>
    <div class="name">${esc(diver?.name)}</div>
    <div class="team">${esc(diver?.team || "")}</div>
    <div class="dive-line">
      ${c.code ? `<span class="dive-code">${esc(c.code)}</span>` : ""}
      <span class="dive-desc">${esc(describeDive(c.code))}</span>
      <span class="dd">DD <b>${fmtDD(c.dd)}</b></span>
    </div>
    <div class="tiles" style="--n:${c.submitted.length}">${tiles}</div>
    ${res?.failed ? `<div class="failed-tag">FAILED DIVE</div>` : ""}
    ${revealed ? `<div class="result">
        <div class="box hl"><div class="k">Dive points</div><div class="v">${fmtPts(res.award)}</div></div>
        <div class="box"><div class="k">Total</div><div class="v">${fmtPts(st?.total)}</div></div>
        <div class="box"><div class="k">Position</div><div class="v">${st ? ordinal(st.rank) : "–"}</div></div>
      </div>` : ""}
    ${upNext}`;
}

function renderStandings() {
  const curId = state.current?.diverId;
  $("#standings").innerHTML =
    state.standings
      .map((row) => {
        const d = diverById(state, row.diverId);
        const open = expanded.has(row.diverId);
        const dives = Array.from({ length: state.rounds }, (_, r) => {
          const res = state.results[`${row.diverId}:${r}`];
          return res ? `<span title="${esc(describeDive(res.code))}">R${r + 1} ${esc(res.code)} ${fmtPts(res.award)}</span>` : "";
        }).join("");
        return `<tr class="diver-row ${row.diverId === curId ? "now" : ""}" data-diver="${row.diverId}" aria-expanded="${open}">
          <td class="rk">${row.done ? row.rank : "–"}</td>
          <td class="nm">${esc(d.name)}<small>${esc(d.team)}</small></td>
          <td class="tot">${fmtPts(row.total)}<small>${row.done}/${state.rounds} dives</small></td>
        </tr>${open ? `<tr class="detail"><td></td><td colspan="2"><div class="mini">${dives || '<span>No dives yet</span>'}</div></td></tr>` : ""}`;
      })
      .join("") || `<tr><td class="muted">No divers yet</td></tr>`;
}

function render() {
  document.title = `${state.name} · Live`;
  $("#meetName").textContent = [state.name, state.event].filter(Boolean).join(" · ");
  const pill = $("#roundPill");
  const round = state.current ? state.current.round : state.next?.round;
  pill.hidden = round === undefined;
  if (round !== undefined) pill.textContent = `Round ${round + 1} of ${state.rounds}`;
  renderStage();
  renderStandings();
}

function onStatus(status) {
  $("#connDot").className = `dot ${status}`;
  $("#connText").textContent = status === "online" ? "LIVE" : status === "connecting" ? "Connecting" : "Offline";
}

api(`/api/meets/${code}`)
  .then(() => liveSocket({ code, role: "audience", onState: (s) => ((state = s), render()), onStatus }))
  .catch((err) => {
    $("#meetName").textContent = err.status === 404 ? `Meet ${code} not found` : err.message;
  });
