// Competition control. The head referee sees a "Judge panels" tab and a tab
// per platform; a platform referee (opened with that platform's link) sees
// only their platform. On a platform tab the referee puts a group on the
// platform, calls divers, watches the judges' scores come in, and reveals.
import { $, confirmDialog, esc, fmtDD, fmtPts, fmtScore, liveSocket, store } from "/common.js";
import { heightLabel } from "/ddtable.js";
import { describeDive } from "/dives.js";
import { buildXlsx, competitionSheets } from "/xlsx.js";

const params = new URLSearchParams(location.search);
const code = (params.get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
// A platform referee's key is stored separately so it never replaces the head key.
const platformParam = params.get("p") || "";
const storeKey = platformParam ? `compplat:${code}:${platformParam}` : `comp:${code}`;
let key = null;
let sock = null;
let state = null;
let ref = 0;
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
  if (sock?.send({ ...msg, ref: ++ref })) return true;
  toast("Offline. Reconnecting…");
  return false;
}

const isHead = () => state?.scope === "all";
const judgeName = (id) => state.judges.find((j) => j.id === id)?.name ?? "";
const platformById = (id) => state.platforms.find((p) => p.id === id);
const platformName = (id) => platformById(id)?.name ?? "";
const groupById = (id) => state.groups.find((g) => g.id === id);
const diverById = (id) => state.divers.find((d) => d.id === id);

function seatOf(judgeId) {
  for (const p of state.platforms) {
    const i = (state.panels[p.id] || []).indexOf(judgeId);
    if (i >= 0) return { platformId: p.id, seat: i + 1, active: i < state.sizes[p.id] };
  }
  return null;
}

// ---------- tabs ----------
function visiblePlatforms() {
  return isHead() ? state.platforms : state.platforms.filter((p) => p.id === state.scope);
}

function renderTabs() {
  const tabs = [...(isHead() ? [{ id: "panels", label: "Judge panels" }] : []), ...visiblePlatforms().map((p) => ({ id: p.id, label: p.name }))];
  if (!tabs.some((t) => t.id === tab)) tab = store.get(`ctab:${code}`) ?? tabs[0]?.id;
  if (!tabs.some((t) => t.id === tab)) tab = tabs[0]?.id;
  $("#tabs").hidden = tabs.length < 2;
  $("#tabs").innerHTML = tabs
    .map((t) => {
      const l = state.live[t.id];
      const busy = l?.current?.phase === "scoring" ? `<span class="dirty-dot" title="Dive being judged"></span>` : "";
      return `<button data-tab="${esc(t.id)}" class="${t.id === tab ? "on" : ""}">${esc(t.label)}${busy}</button>`;
    })
    .join("");
  $("#panelsView").hidden = tab !== "panels";
  $("#platformView").hidden = tab === "panels";
}

$("#tabs").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tab]");
  if (!b) return;
  tab = b.dataset.tab;
  store.set(`ctab:${code}`, tab);
  render();
});

// ---------- share + judges (panels tab) ----------
function renderShare() {
  const url = `${location.origin}/pad?c=${code}`;
  const refLinks = state.platformKeys
    ? `<div class="item"><label>Platform referee links · keep private</label>
        <div class="btns">${state.platforms
          .map((p) => `<button class="btn small" data-copyplat="${esc(p.id)}">Copy ${esc(p.name)} link</button>`)
          .join("")}</div>
        <p class="muted small">Opens one platform's scoring on another device. It can't change panels or the setup.</p></div>`
    : "";
  $("#shareBox").innerHTML = `
    <div class="item"><label>Judge link</label><div class="link mono">${esc(url)}</div>
      <div class="pin">PIN <span class="mono">${esc(state.judgePin)}</span></div>
      <div class="btns"><button class="btn small primary" id="copyJudge">Copy judge invite</button>
      ${navigator.share ? `<button class="btn small" id="shareJudge">Share…</button>` : ""}</div>
      <p class="muted small">Or on the home page: Judge → code <b class="mono">${esc(code)}</b>.</p></div>
    <div class="item"><label>Audience scoreboard</label><div class="link mono">${esc(`${location.origin}/show?c=${code}`)}</div>
      <div class="btns"><button class="btn small" id="copyShow">Copy link</button>
      <a class="btn small" href="/show?c=${esc(code)}" target="_blank" rel="noopener">Open ↗</a></div>
      <p class="muted small">All platforms and standings. Pick one platform on the scoreboard for the screen by that pool. No sign-in needed.</p></div>${refLinks}`;
  $("#copyShow").addEventListener("click", () => copy(`${location.origin}/show?c=${code}`, "Scoreboard link copied"));
  const text = `Judge pad for ${state.name}: ${url}  PIN ${state.judgePin}`;
  $("#copyJudge").addEventListener("click", () => copy(text, "Judge invite copied"));
  $("#shareJudge")?.addEventListener("click", () => navigator.share({ title: state.name, text }).catch(() => {}));
}

async function copy(text, done) {
  try {
    await navigator.clipboard.writeText(text);
    toast(done, 2000, true);
  } catch {
    prompt("Copy this", text);
  }
}

$("#shareBox").addEventListener("click", (e) => {
  const b = e.target.closest("[data-copyplat]");
  if (!b) return;
  const pid = b.dataset.copyplat;
  copy(`${location.origin}/control?c=${code}&p=${encodeURIComponent(pid)}#key=${state.platformKeys[pid]}`, `${platformName(pid)} referee link copied`);
});

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

// ---------- platform tab ----------
function groupPicker(p, l) {
  const prog = state.progress[p.id] || {};
  const elsewhere = (gid) => state.platforms.find((x) => x.id !== p.id && state.live[x.id]?.groupId === gid);
  const opts = Object.entries(prog)
    .map(([gid, pr]) => {
      const g = groupById(gid);
      const other = elsewhere(gid);
      const status = pr.done === pr.total && pr.total ? "done ✓" : `${pr.done}/${pr.total}`;
      return `<option value="${esc(gid)}" ${gid === l.groupId ? "selected" : ""} ${other ? "disabled" : ""}>${esc(g.name)} · ${status}${other ? ` · on ${esc(other.name)}` : ""}</option>`;
    })
    .join("");
  return `<div class="group-bar">
    <label for="groupSel">Group on ${esc(p.name)}</label>
    <select id="groupSel" data-plat="${esc(p.id)}"><option value="">— none —</option>${opts}</select>
  </div>`;
}

function scoreTiles(p, c, res) {
  const online = new Set(state.online);
  const seats = state.panels[p.id] || [];
  return `<div class="tiles" style="--n:${c.scores.length}">${c.scores
    .map((v, i) => {
      const jid = seats[i];
      const cls = v === null ? "waiting" : res?.dropped.includes(i) ? "dropped" : "in";
      return `<button class="tile ref ${cls}" data-seat="${i + 1}" title="Click to override">
        <span class="conn dot ${jid && online.has(jid) ? "online" : "offline"}"></span>
        <span class="j">S${i + 1} ${esc(jid ? judgeName(jid) : "empty")}</span><span class="s">${fmtScore(v)}</span></button>`;
    })
    .join("")}</div>`;
}

function currentCard(p, l) {
  const g = groupById(l.groupId);
  if (!g) {
    return `<h2>No group on ${esc(p.name)}</h2><p class="lead">Pick the group that's diving here. Judges' pads open when you call the first diver.</p>`;
  }
  const pr = state.progress[p.id]?.[g.id] || { done: 0, total: 0 };
  const nx = state.next[p.id];
  const nxDiver = nx && diverById(nx.diverId);
  const nextBtn = `<button class="btn primary next" data-act="next" ${nx ? "" : "disabled"}>${
    nx ? `Call next ▶ ${esc(nxDiver.name)} · Dive ${nx.round + 1}` : "All dives on this platform scored"
  } <span style="font-weight:500;font-size:13px;opacity:.6">(N)</span></button>`;
  const c = l.current;
  if (!c) {
    const done = pr.total && pr.done === pr.total;
    // The first platform in the rotation after this group's last round here.
    const lastHere = g.plan.reduce((m, s, r) => (s.platformId === p.id ? r : m), -1);
    const nextPlat = done ? g.plan.find((s, r) => r > lastHere && s.platformId !== p.id) : null;
    return `<h2>${esc(g.name)} · ${pr.done}/${pr.total} dives</h2>
      ${done
        ? `<p class="lead">${esc(g.name)} has finished on ${esc(p.name)}.${nextPlat ? ` Their next platform is <b>${esc(platformName(nextPlat.platformId))}</b>.` : ""} Take them off this platform so they can start there.</p>
           <div class="ref-controls"><button class="btn primary" data-act="release">Take ${esc(g.name)} off ${esc(p.name)}</button></div>`
        : `<p class="lead">Call the next diver to open the judges' pads.</p><div class="ref-controls">${nextBtn}</div>`}`;
  }
  const diver = diverById(c.diverId);
  const revealed = c.phase === "revealed";
  const res = revealed ? state.results[`${c.diverId}:${c.round}`] : null;
  const allIn = c.scores.every((v) => v !== null);
  const options = [...new Set([...diver.dives.filter(Boolean).map((d) => d.code), ...(diver.extra || [])].filter(Boolean))];
  return `
    <div class="row" style="align-items:baseline">
      <h2 style="flex:1 1 auto">${esc(diver.name)} <span class="muted" style="font-weight:500">${esc(diver.team)}</span></h2>
      <span class="pill" style="flex:none">Dive ${c.round + 1}/${g.plan.length} · ${esc(c.height)}m</span>
      <span class="pill" style="flex:none;${revealed ? "color:var(--good)" : "color:var(--warn)"}">${revealed ? "Revealed" : "Judging"}</span>
    </div>
    <form class="row dive-edit" id="diveForm" style="margin-top:10px;align-items:flex-end">
      <div class="field"><label for="cCode">Dive</label><input id="cCode" class="mono" value="${esc(c.code)}" placeholder="105B" autocapitalize="characters" list="diveOpts" autocomplete="off"></div>
      <div class="field"><label for="cDD">DD <span class="muted small">(blank = table)</span></label><input id="cDD" class="mono" inputmode="decimal" placeholder="${fmtDD(c.dd)}" autocomplete="off"></div>
      <button class="btn" style="flex:0 0 auto">Change dive</button>
      <datalist id="diveOpts">${options.map((o) => `<option value="${esc(o)}">${esc(describeDive(o))}</option>`).join("")}</datalist>
    </form>
    <div class="dive-line" style="margin:10px 0 14px"><span class="dive-code">${esc(c.code || "—")}</span><span class="dive-desc">${esc(describeDive(c.code))}</span>
      <span class="pill">DD <b class="mono">${fmtDD(c.dd)}</b></span></div>
    ${scoreTiles(p, c, res)}
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

function orderTable(p, l) {
  const g = groupById(l.groupId);
  if (!g) return "";
  const rounds = g.plan.map((s, r) => (s.platformId === p.id ? r : -1)).filter((r) => r >= 0);
  const divers = state.divers.filter((d) => d.groupId === g.id);
  const c = l.current;
  const head = `<tr><th>Diver</th>${rounds.map((r) => `<th>Dive ${r + 1}</th>`).join("")}</tr>`;
  const rows = divers
    .map((d) => {
      const cells = rounds
        .map((r) => {
          const res = state.results[`${d.id}:${r}`];
          const cur = c && c.diverId === d.id && c.round === r;
          const codeTxt = res?.code || d.dives[r]?.code || "—";
          return `<td class="slot ${res ? "done" : ""} ${cur ? "cur" : ""}" data-call="${esc(d.id)}:${r}"><span class="c">${esc(codeTxt)}</span>${res ? `<b>${fmtPts(res.award)}</b>` : "&nbsp;"}</td>`;
        })
        .join("");
      return `<tr><td>${esc(d.name)}</td>${cells}</tr>`;
    })
    .join("");
  return `<section class="card"><h2>Running order · ${esc(g.name)} on ${esc(p.name)}</h2>
    <p class="lead">Click any dive to call it, or to review one already scored.</p>
    <div class="order-wrap"><table class="order">${head}${rows}</table></div></section>`;
}

function standingsCard(l) {
  const g = groupById(l.groupId);
  if (!g) return "";
  const rows = (state.standings[g.id] || [])
    .map((r) => {
      const d = diverById(r.diverId);
      return `<tr class="diver-row"><td class="rk">${r.rank}</td><td class="nm">${esc(d.name)}<small>${esc(d.team)}</small></td>
        <td class="tot">${fmtPts(r.total)}<small>${r.done}/${r.rounds} dives</small></td></tr>`;
    })
    .join("");
  return `<section class="card"><h2>Standings · ${esc(g.name)}</h2><p class="lead">All dives so far, on every platform.</p>
    <table class="standings">${rows}</table></section>`;
}

function renderPlatform() {
  const p = platformById(tab);
  if (!p) return;
  const l = state.live[p.id] || { groupId: null, current: null };
  // Keep what the referee is typing in the dive form across live updates.
  const keep = ["cCode", "cDD"].map((id) => [id, $(`#${id}`)?.value, document.activeElement?.id === id]);
  const sameDive = renderPlatform.seq === l.current?.seq;
  $("#platformView").innerHTML = `
    <section class="card">${groupPicker(p, l)}</section>
    <div class="ref-grid" style="margin-top:16px">
      <section class="card" id="currentCard">${currentCard(p, l)}</section>
      <div class="stack">${standingsCard(l)}</div>
    </div>
    <div style="margin-top:16px">${orderTable(p, l)}</div>`;
  if (sameDive) {
    for (const [id, v, focused] of keep) {
      const el = $(`#${id}`);
      if (el && v !== undefined) el.value = v;
      if (el && focused) el.focus();
    }
  }
  renderPlatform.seq = l.current?.seq;
}

$("#platformView").addEventListener("change", async (e) => {
  if (e.target.id !== "groupSel") return;
  const pid = e.target.dataset.plat;
  const l = state.live[pid];
  const to = e.target.value || null;
  if (l?.current && !(await confirmDialog(`Switch the group on ${platformName(pid)}? The called dive is cancelled.`, { ok: "Switch" }))) {
    e.target.value = l.groupId || "";
    return;
  }
  send({ type: "startGroup", platformId: pid, groupId: to });
});

$("#platformView").addEventListener("submit", (e) => {
  if (e.target.id !== "diveForm") return;
  e.preventDefault();
  const codeVal = $("#cCode").value.trim();
  const dd = $("#cDD").value.trim().replace(",", ".");
  if (send({ type: "setDive", platformId: tab, code: codeVal, dd: dd === "" ? null : Number(dd) })) {
    $("#cDD").value = "";
    renderPlatform.seq = null;
  }
});

$("#platformView").addEventListener("click", async (e) => {
  const tile = e.target.closest("[data-seat]");
  if (tile) return openScoreDialog(Number(tile.dataset.seat));
  const slot = e.target.closest("[data-call]");
  if (slot) {
    const [diverId, round] = slot.dataset.call.split(":");
    return send({ type: "call", platformId: tab, diverId, round: Number(round) });
  }
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (!act) return;
  if (act === "failed" && !(await confirmDialog("Mark this dive as failed (all scores 0)?", { ok: "Failed dive", danger: true }))) return;
  if (act === "release") return send({ type: "startGroup", platformId: tab, groupId: null });
  send({ type: act, platformId: tab });
});

// Score override dialog
let dlgSeat = null;
$("#dlgGrid").innerHTML = Array.from({ length: 21 }, (_, i) => `<button class="btn" data-v="${i / 2}">${fmtScore(i / 2)}</button>`).join("");
function openScoreDialog(seat) {
  const c = state.live[tab]?.current;
  if (!c || c.phase !== "scoring") return toast("Re-open scoring to change a score");
  dlgSeat = seat;
  const jid = state.panels[tab]?.[seat - 1];
  $("#dlgTitle").textContent = `Set score for seat ${seat}${jid ? ` (${judgeName(jid)})` : ""}`;
  $("#scoreDlg").showModal();
}
$("#dlgGrid").addEventListener("click", (e) => {
  const b = e.target.closest("[data-v]");
  if (!b) return;
  send({ type: "setScore", platformId: tab, seat: dlgSeat, value: Number(b.dataset.v) });
  $("#scoreDlg").close();
});
$("#dlgClear").addEventListener("click", () => {
  send({ type: "setScore", platformId: tab, seat: dlgSeat, value: null });
  $("#scoreDlg").close();
});
$("#dlgCancel").addEventListener("click", () => $("#scoreDlg").close());

document.addEventListener("keydown", (e) => {
  if (tab === "panels" || !state || e.target.closest("input, select, textarea, dialog") || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "n" || e.key === "N") $('#platformView [data-act="next"]:not(:disabled)')?.click();
  if (e.key === "r" || e.key === "R") $('#platformView [data-act="reveal"]:not(:disabled)')?.click();
});

// ---------- Excel ----------
$("#xlsxBtn").addEventListener("click", () => {
  if (!state) return;
  const blob = new Blob([buildXlsx(competitionSheets(state))], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${String(state.name || "competition").replace(/[^\w-]+/g, "_")}_results.xlsx`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

// ---------- render ----------
function render() {
  $("#compName").textContent = isHead() ? state.name : `${state.name} · ${platformName(state.scope)}`;
  document.title = `${state.name} · Control`;
  $("#setupLink").hidden = !isHead();
  $("#showLink").href = isHead() ? `/show?c=${code}` : `/show?c=${code}&p=${encodeURIComponent(state.scope)}`;
  renderTabs();
  if (tab === "panels") {
    renderShare();
    renderJudges();
    // Don't rebuild the seat pickers while one is open.
    if (document.activeElement?.tagName === "SELECT" && $("#panels").contains(document.activeElement)) renderPanels.pending = true;
    else renderPanels();
  } else if (!$("#scoreDlg").open) renderPlatform();
}
$("#panels").addEventListener("focusout", () => {
  if (renderPanels.pending) {
    renderPanels.pending = false;
    setTimeout(renderPanels, 0);
  }
});
$("#scoreDlg").addEventListener("close", () => state && tab !== "panels" && renderPlatform());

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
        const saved = store.get(storeKey) || {};
        store.set(storeKey, { ...saved, key, name: s.name, createdAt: saved.createdAt || Date.now() });
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
  $("#tabs").hidden = true;
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
const initialKey = hashKey || store.get(storeKey)?.key;
if (initialKey) start(initialKey);
else askKey();
