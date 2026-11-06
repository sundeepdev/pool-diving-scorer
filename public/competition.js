// Multi-platform competition setup: platforms, judges, groups with a rotation
// across platforms, and each diver's declared dives. Edits are kept in a local
// draft and saved to the competition with "Save setup".
import { $, $$, confirmDialog, esc, store } from "/common.js";
import { JUDGE_PANELS, SetupError, normalizeSetup, roundPlan, setupWarnings } from "/competition-model.js";
import { HEIGHTS, heightLabel, lookupDD } from "/ddtable.js";
import { describeDive } from "/dives.js";
import { competitionDiversToCsv, parseImport } from "/importer.js";

const code = (new URLSearchParams(location.search).get("c") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
const CODE_RE = /^\d{3,4}[A-D]$/i;

let key = null;
let version = 0;
let saved = null; // last setup from the server
let draft = null;
let dirty = false;
let saving = false;
let importParsed = null;

// ---------- helpers ----------
function toast(text, ms = 3000, ok = false) {
  const t = $("#toast");
  t.textContent = text;
  t.classList.toggle("ok", ok);
  t.classList.remove("hidden");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.add("hidden"), ms);
}

const newId = (p) => p + crypto.getRandomValues(new Uint32Array(2)).reduce((s, n) => s + n.toString(36), "").slice(0, 10);

function download(name, text, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
const fileSafe = (s) => String(s || "competition").replace(/[^\w-]+/g, "_");

async function request(method, body) {
  const res = await fetch(`/api/competitions/${code}/setup`, {
    method,
    headers: { "x-referee-key": key, ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status, data });
  return data;
}

function setDirty(v) {
  dirty = v;
  $("#saveBtn").disabled = !v || saving;
  $("#discardBtn").hidden = !v || saving;
  $("#saveStatus").textContent = saving ? "Saving…" : v ? "Unsaved changes" : "All changes saved";
  $("#saveStatus").className = v ? "warn-text" : "muted";
  $("#savebar").classList.toggle("dirty", v);
}
function changed({ render = false } = {}) {
  setDirty(true);
  if (render) renderAll();
  else renderWarnings();
}

const platformById = (id) => draft.platforms.find((p) => p.id === id);
const groupById = (id) => draft.groups.find((g) => g.id === id);
const membersOf = (gid) => draft.divers.filter((d) => (d.groupId || null) === gid);
const planOf = (g) => (g ? roundPlan(g, draft.platforms) : []);

// Fills in DD from the table for every dive that hasn't been typed by hand,
// using the height of that round in the diver's group rotation.
function refreshDD(diver) {
  const plan = planOf(groupById(diver.groupId));
  diver.dives.forEach((dv, r) => {
    if (!dv || !dv.code || !(dv.auto || !dv.dd)) return;
    const dd = plan[r]?.height ? lookupDD(dv.code, plan[r].height) : null;
    dv.dd = dd ?? "";
    dv.auto = dd !== null;
  });
}
const refreshGroup = (gid) => membersOf(gid).forEach(refreshDD);

// ---------- competition + share ----------
function renderShare() {
  const ref = `${location.origin}/competition?c=${code}#key=${key}`;
  $("#shareBox").innerHTML = `
    <div class="item"><label>Competition code</label><div class="big">${esc(code)}</div>
      <p class="muted small">Judges enter this code on the home page, or use the judge link on the <a href="/control?c=${esc(code)}">Judge panels</a> page.</p></div>
    <div class="item"><label>Judge PINs</label>
      <p class="muted small">Each judge gets their own PIN once you save them. Find the PINs and personal invites on the <a href="/control?c=${esc(code)}">Run competition</a> page.</p></div>
    <div class="item"><label>Setup link · keep private</label>
      <div class="btns"><button class="btn small" id="copyRef">Copy setup link</button></div>
      <p class="muted small">Opens this setup on another device, for example a second referee's laptop.</p></div>`;
  $("#copyRef").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ref);
      toast("Setup link copied", 2000, true);
    } catch {
      prompt("Copy this link", ref);
    }
  });
}

$("#cName").addEventListener("input", (e) => {
  draft.name = e.target.value;
  $("#compName").textContent = draft.name || "Competition";
  changed();
});

// ---------- platforms ----------
$("#quickPlatforms").innerHTML = HEIGHTS.map((h) => `<button type="button" class="btn" data-addplat="${h}">+ ${h}m</button>`).join("");

function renderPlatforms() {
  $("#platCount").textContent = draft.platforms.length ? `(${draft.platforms.length})` : "";
  $("#platformList").innerHTML = draft.platforms.length
    ? draft.platforms
        .map(
          (p, i) => `<div class="chip plat">
        <input data-plat="${i}" data-f="name" value="${esc(p.name)}" maxlength="40" aria-label="Platform name">
        <select data-plat="${i}" data-f="height" aria-label="Height">${HEIGHTS.map((h) => `<option value="${h}" ${h === p.height ? "selected" : ""}>${esc(heightLabel(h))}</option>`).join("")}</select>
        <button type="button" class="icon-btn del" data-delplat="${i}" title="Remove platform">✕</button></div>`,
        )
        .join("")
    : `<p class="muted empty-note">No platforms yet. Tap a height above to add one.</p>`;
}

$("#quickPlatforms").addEventListener("click", (e) => {
  const b = e.target.closest("[data-addplat]");
  if (!b) return;
  const h = b.dataset.addplat;
  const same = draft.platforms.filter((p) => p.height === h).length;
  draft.platforms.push({ id: newId("p"), name: same ? `${h}m (${same + 1})` : `${h}m`, height: h });
  // A group with no rotation yet starts on the first platform added.
  if (draft.platforms.length === 1) for (const g of draft.groups) if (!g.legs.length) g.legs.push({ platformId: draft.platforms[0].id, dives: defaultDives(g) });
  draft.groups.forEach((g) => refreshGroup(g.id));
  changed({ render: true });
});

$("#platformList").addEventListener("input", (e) => {
  const el = e.target.closest("[data-plat]");
  if (!el) return;
  const p = draft.platforms[Number(el.dataset.plat)];
  p[el.dataset.f] = el.value;
  if (el.dataset.f === "height") {
    draft.groups.forEach((g) => refreshGroup(g.id));
    changed({ render: true });
  } else {
    $$(`option[data-platopt="${p.id}"]`).forEach((o) => (o.textContent = p.name || `${p.height}m`));
    changed();
  }
});

$("#platformList").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-delplat]");
  if (!b) return;
  const p = draft.platforms[Number(b.dataset.delplat)];
  const used = draft.groups.filter((g) => g.legs.some((l) => l.platformId === p.id));
  if (used.length && !(await confirmDialog(`${p.name} is in the rotation of ${used.map((g) => g.name).join(", ")}. Remove it from those rotations too?`, { ok: "Remove", danger: true }))) return;
  draft.platforms = draft.platforms.filter((x) => x !== p);
  for (const g of used) {
    g.legs = g.legs.filter((l) => l.platformId !== p.id);
    refreshGroup(g.id);
  }
  changed({ render: true });
});

// ---------- judges ----------
function renderJudges() {
  $("#judgeCount").textContent = draft.judges.length ? `(${draft.judges.length})` : "";
  $("#judgeList").innerHTML = draft.judges
    .map(
      (j, i) => `<div class="chip"><input data-judge="${i}" value="${esc(j.name)}" maxlength="60" aria-label="Judge name">
      <button type="button" class="icon-btn del" data-deljudge="${i}" title="Remove judge">✕</button></div>`,
    )
    .join("");
}

$("#judgeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const known = new Set(draft.judges.map((j) => j.name.trim().toLowerCase()));
  let added = 0;
  for (const line of $("#judgeText").value.split(/\r?\n/)) {
    // Spreadsheet paste: take the first column. A single line with commas is a list of names.
    const parts = line.includes("\t") ? [line.split("\t")[0]] : /,/.test(line) && !line.includes("  ") ? line.split(",") : [line];
    for (const raw of parts) {
      const name = raw.trim().replace(/^"|"$/g, "").slice(0, 60);
      if (!name || /^(name|judges?)$/i.test(name) || known.has(name.toLowerCase())) continue;
      known.add(name.toLowerCase());
      draft.judges.push({ id: newId("j"), name });
      added++;
    }
  }
  $("#judgeText").value = "";
  if (!added) return toast("No new names to add");
  changed({ render: true });
  toast(`Added ${added} judge${added > 1 ? "s" : ""}`, 2000, true);
});

$("#judgeList").addEventListener("input", (e) => {
  const el = e.target.closest("[data-judge]");
  if (!el) return;
  draft.judges[Number(el.dataset.judge)].name = el.value;
  changed();
});
$("#judgeList").addEventListener("click", (e) => {
  const b = e.target.closest("[data-deljudge]");
  if (!b) return;
  draft.judges.splice(Number(b.dataset.deljudge), 1);
  changed({ render: true });
});

// ---------- groups and divers ----------
const defaultDives = (g) => Math.max(1, ...membersOf(g.id).map((d) => d.dives.length));

function addGroup(name) {
  const g = { id: newId("g"), name, panel: 5, autoReveal: true, legs: [] };
  if (draft.platforms.length === 1) g.legs.push({ platformId: draft.platforms[0].id, dives: 1 });
  draft.groups.push(g);
  return g;
}

function rotationHtml(g, gi) {
  const opts = (sel) =>
    draft.platforms.map((p) => `<option value="${esc(p.id)}" data-platopt="${esc(p.id)}" ${p.id === sel ? "selected" : ""}>${esc(p.name || `${p.height}m`)}</option>`).join("");
  const legs = g.legs
    .map(
      (l, li) => `${li ? `<span class="arrow" aria-hidden="true">→</span>` : ""}<span class="leg">
      <select data-g="${gi}" data-leg="${li}" data-f="platformId" aria-label="Platform for leg ${li + 1}">${opts(l.platformId)}</select>
      <span class="x">×</span><input data-g="${gi}" data-leg="${li}" data-f="dives" type="number" min="1" max="12" inputmode="numeric" value="${l.dives}" aria-label="Dives on this platform">
      <span class="muted small">dive${l.dives === 1 ? "" : "s"}</span>
      <button type="button" class="icon-btn del" data-act="delleg" data-g="${gi}" data-leg="${li}" title="Remove this leg">✕</button></span>`,
    )
    .join("");
  return `<div class="rotation"><span class="label">Rotation</span>${legs || `<span class="muted small">No platform yet</span>`}
    <button type="button" class="btn small" data-act="addleg" data-g="${gi}" ${draft.platforms.length ? "" : "disabled"}>+ Platform</button>
    ${draft.groups.length > 1 && g.legs.length ? `<button type="button" class="btn small" data-act="copyrot" data-g="${gi}">Copy rotation to all groups</button>` : ""}</div>`;
}

function diverRows(list, plan, n, gi) {
  return list
    .map((d) => {
      const i = draft.divers.indexOf(d);
      const pos = list.indexOf(d);
      const cells = Array.from({ length: n }, (_, r) => {
        const dv = d.dives[r] || { code: "", dd: "" };
        const c = dv.code || "";
        const dd = typeof dv.dd === "number" && dv.dd ? dv.dd.toFixed(1) : dv.dd || "";
        const beyond = r >= plan.length;
        const noDD = c && CODE_RE.test(c) && !dd;
        return `<td class="dive-cell${beyond ? " beyond" : ""}" data-label="Dive ${r + 1}${plan[r]?.height ? ` · ${plan[r].height}m` : ""}"><div class="pair">
            <input class="code ${!c || CODE_RE.test(c) ? "" : "invalid"}" data-i="${i}" data-r="${r}" data-f="code" value="${esc(c)}" placeholder="dive" maxlength="5" autocapitalize="characters" autocomplete="off" aria-label="${esc(d.name)} dive ${r + 1}">
            <input class="ddin ${dv.auto ? "auto" : ""} ${noDD ? "invalid" : ""}" data-i="${i}" data-r="${r}" data-f="dd" value="${esc(dd)}" placeholder="DD" inputmode="decimal" maxlength="4" autocomplete="off" title="${dv.auto ? "From the World Aquatics table. Type to override." : "Typed by hand"}" aria-label="${esc(d.name)} dive ${r + 1} DD">
          </div><div class="desc" data-desc="${i}:${r}">${esc(describeDive(c))}</div></td>`;
      }).join("");
      const groupOpts = [`<option value="">No group</option>`, ...draft.groups.map((g) => `<option value="${esc(g.id)}" ${g.id === d.groupId ? "selected" : ""}>${esc(g.name)}</option>`)].join("");
      return `<tr>
        <td class="num">${pos + 1}</td>
        <td><input data-i="${i}" data-f="name" value="${esc(d.name)}" maxlength="60" class="${d.name.trim() ? "" : "invalid"}" aria-label="Diver name"></td>
        <td><input data-i="${i}" data-f="team" value="${esc(d.team)}" maxlength="40" aria-label="Team"></td>
        ${cells}
        <td class="extra-cell"><input class="extra" data-i="${i}" data-f="extra" value="${esc((d.extra || []).join(" "))}" placeholder="e.g. 103C 201B" autocapitalize="characters" autocomplete="off" aria-label="${esc(d.name)} other dives" title="Other dives this diver can do. They're listed first when a dive is changed during the competition."></td>
        <td class="acts">
          <button type="button" class="icon-btn" data-act="up" data-i="${i}" data-g="${gi}" title="Move up" ${pos === 0 ? "disabled" : ""}>↑</button>
          <button type="button" class="icon-btn" data-act="down" data-i="${i}" data-g="${gi}" title="Move down" ${pos === list.length - 1 ? "disabled" : ""}>↓</button>
          <select class="move" data-i="${i}" data-f="groupId" title="Move to group" aria-label="Group">${groupOpts}</select>
          <button type="button" class="icon-btn del" data-act="remove" data-i="${i}" title="Remove diver">✕</button>
        </td></tr>`;
    })
    .join("");
}

function groupHtml(g, gi) {
  const list = membersOf(g ? g.id : null);
  const plan = planOf(g);
  const n = Math.max(plan.length, ...list.map((d) => d.dives.length), g ? 1 : 0);
  const head = `<thead><tr><th>#</th><th>Diver</th><th>Team / club</th>${Array.from(
    { length: n },
    (_, r) => `<th>Dive ${r + 1}<span class="sub">${plan[r] ? esc(platformById(plan[r].platformId)?.name || `${plan[r].height}m`) : g ? "not in rotation" : ""}</span></th>`,
  ).join("")}<th>Other dives<span class="sub">can also do</span></th><th></th></tr></thead>`;
  const rows = diverRows(list, plan, n, gi);
  const table = `<div class="order-wrap"><table class="divers-table">${head}<tbody>${
    rows || `<tr><td colspan="${n + 5}" class="empty">No divers in this group yet</td></tr>`
  }</tbody></table></div>`;
  if (!g) {
    return list.length
      ? `<section class="group-card"><div class="group-head"><h3>Not in a group <span class="muted">(${list.length})</span></h3></div>
        <p class="muted small">Pick a group for each diver with the menu on the right of the row.</p>${table}</section>`
      : "";
  }
  return `<section class="group-card" data-gid="${esc(g.id)}">
    <div class="group-head">
      <input class="gname" data-g="${gi}" data-f="name" value="${esc(g.name)}" maxlength="60" aria-label="Group name">
      <span class="muted">${list.length} diver${list.length === 1 ? "" : "s"}</span>
      <label class="inline">Judges <select data-g="${gi}" data-f="panel">${JUDGE_PANELS.map((p) => `<option ${p === g.panel ? "selected" : ""}>${p}</option>`).join("")}</select></label>
      <label class="check inline"><input type="checkbox" data-g="${gi}" data-f="autoReveal" ${g.autoReveal ? "checked" : ""}> Show scores when all judges are in</label>
      <span class="spacer"></span>
      <button type="button" class="btn small" data-act="draw" data-g="${gi}" ${list.length > 1 ? "" : "disabled"}>Draw order</button>
      <button type="button" class="btn small danger" data-act="delgroup" data-g="${gi}">Delete group</button>
    </div>
    ${rotationHtml(g, gi)}
    ${table}
    <form class="add-row" data-addto="${gi}">
      <input name="name" placeholder="Diver name" maxlength="60" aria-label="New diver name" autocomplete="off">
      <input name="team" placeholder="Team / club" maxlength="40" aria-label="New diver team" autocomplete="off">
      <button class="btn primary">+ Add diver</button>
    </form>
  </section>`;
}

function renderGroups() {
  $("#diverCount").textContent = draft.divers.length ? `(${draft.divers.length} divers in ${draft.groups.length} group${draft.groups.length === 1 ? "" : "s"})` : "";
  const html = draft.groups.map((g, gi) => groupHtml(g, gi)).join("") + groupHtml(null, -1);
  $("#groups").innerHTML =
    html || `<p class="muted empty-note">No groups yet. <b>Import divers…</b> with a Group column, or press <b>+ Add group</b>.</p>`;
}

$("#addGroupBtn").addEventListener("click", () => {
  addGroup(`Group ${draft.groups.length + 1}`);
  changed({ render: true });
  $("#groups .group-card:last-of-type .gname")?.select();
});

$("#groups").addEventListener("input", (e) => {
  const el = e.target;
  // Group fields and rotation legs
  if (el.dataset.g !== undefined && el.dataset.i === undefined) {
    const g = draft.groups[Number(el.dataset.g)];
    if (!g) return;
    if (el.dataset.leg !== undefined) {
      const leg = g.legs[Number(el.dataset.leg)];
      if (el.dataset.f === "dives") {
        const n = Math.round(Number(el.value));
        if (!(n >= 1 && n <= 12)) return;
        leg.dives = n;
      } else leg.platformId = el.value;
      refreshGroup(g.id);
      // Typing a number: re-render when the field loses focus (see "change").
      return changed({ render: el.dataset.f !== "dives" });
    }
    if (el.dataset.f === "name") {
      g.name = el.value;
      $$(`.move option[value="${g.id}"]`).forEach((o) => (o.textContent = el.value));
      return changed();
    }
    if (el.dataset.f === "panel") g.panel = Number(el.value);
    if (el.dataset.f === "autoReveal") g.autoReveal = el.checked;
    return changed();
  }
  // Diver fields
  const d = draft.divers[Number(el.dataset.i)];
  if (!d) return;
  const f = el.dataset.f;
  if (f === "name" || f === "team") {
    d[f] = el.value;
    if (f === "name") el.classList.toggle("invalid", !el.value.trim());
    return changed();
  }
  if (f === "extra") {
    d.extra = el.value.toUpperCase().split(/[\s,;/]+/).filter(Boolean);
    el.classList.toggle("invalid", d.extra.some((c) => !CODE_RE.test(c)));
    return changed();
  }
  if (f === "groupId") {
    d.groupId = el.value || null;
    // Move to the end of the new group's order.
    draft.divers.splice(draft.divers.indexOf(d), 1);
    draft.divers.push(d);
    refreshDD(d);
    return changed({ render: true });
  }
  const r = Number(el.dataset.r);
  while (d.dives.length <= r) d.dives.push(null);
  const dive = (d.dives[r] ||= { code: "", dd: "", auto: true });
  const ddInput = $(`input[data-f="dd"][data-i="${el.dataset.i}"][data-r="${r}"]`);
  if (f === "code") {
    const pos = el.selectionStart;
    el.value = el.value.toUpperCase();
    el.setSelectionRange(pos, pos);
    dive.code = el.value.trim();
    el.classList.toggle("invalid", !!dive.code && !CODE_RE.test(dive.code));
    $(`[data-desc="${el.dataset.i}:${r}"]`).textContent = describeDive(dive.code);
    if (dive.auto || !dive.dd) {
      dive.auto = true;
      refreshDD(d);
      ddInput.value = typeof dive.dd === "number" ? dive.dd.toFixed(1) : "";
      ddInput.classList.toggle("auto", dive.auto);
      ddInput.classList.toggle("invalid", CODE_RE.test(dive.code) && !dive.dd);
    }
  } else {
    const v = el.value.trim().replace(",", ".");
    dive.dd = v === "" ? "" : Number(v) || v;
    dive.auto = v === "";
    if (dive.auto) {
      refreshDD(d);
      // Leave the field empty while typing; the table value appears on the next render.
    }
    el.classList.remove("auto");
    el.classList.toggle("invalid", v !== "" && !(Number(v) > 0 && Number(v) <= 5));
  }
  changed();
});

$("#groups").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const act = b.dataset.act;
  const g = draft.groups[Number(b.dataset.g)];
  if (act === "addleg") {
    const used = new Set(g.legs.map((l) => l.platformId));
    const next = draft.platforms.find((p) => !used.has(p.id)) || draft.platforms[0];
    g.legs.push({ platformId: next.id, dives: g.legs.at(-1)?.dives ?? defaultDives(g) });
    refreshGroup(g.id);
  } else if (act === "delleg") {
    g.legs.splice(Number(b.dataset.leg), 1);
    refreshGroup(g.id);
  } else if (act === "copyrot") {
    if (!(await confirmDialog(`Use the rotation of ${g.name} for every group?`, { ok: "Copy" }))) return;
    for (const other of draft.groups) {
      other.legs = g.legs.map((l) => ({ ...l }));
      refreshGroup(other.id);
    }
  } else if (act === "draw") {
    const list = membersOf(g.id);
    if (!(await confirmDialog(`Randomly draw a new diving order for ${g.name}?`, { ok: "Draw" }))) return;
    for (let i = list.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [list[i], list[j]] = [list[j], list[i]];
    }
    draft.divers = [...draft.divers.filter((d) => d.groupId !== g.id), ...list];
  } else if (act === "delgroup") {
    const n = membersOf(g.id).length;
    if (!(await confirmDialog(n ? `Delete ${g.name}? Its ${n} diver(s) stay in the list without a group.` : `Delete ${g.name}?`, { ok: "Delete", danger: true }))) return;
    draft.groups = draft.groups.filter((x) => x !== g);
    for (const d of draft.divers) if (d.groupId === g.id) d.groupId = null;
  } else if (act === "up" || act === "down" || act === "remove") {
    const d = draft.divers[Number(b.dataset.i)];
    if (act === "remove") {
      if (!(await confirmDialog(`Remove ${d.name || "this diver"}?`, { ok: "Remove", danger: true }))) return;
      draft.divers.splice(draft.divers.indexOf(d), 1);
    } else {
      // Swap with the neighbour in the same group.
      const list = membersOf(d.groupId || null);
      const other = list[list.indexOf(d) + (act === "up" ? -1 : 1)];
      if (!other) return;
      const a = draft.divers.indexOf(d);
      const c = draft.divers.indexOf(other);
      [draft.divers[a], draft.divers[c]] = [draft.divers[c], draft.divers[a]];
    }
  } else return;
  changed({ render: true });
});

$("#groups").addEventListener("submit", (e) => {
  const form = e.target.closest("[data-addto]");
  if (!form) return;
  e.preventDefault();
  const g = draft.groups[Number(form.dataset.addto)];
  const name = form.elements.name.value.trim();
  if (!name) return form.elements.name.focus();
  draft.divers.push({ id: newId("d"), name, team: form.elements.team.value.trim(), groupId: g.id, dives: [], extra: [] });
  changed({ render: true });
  const again = $(`[data-addto="${draft.groups.indexOf(g)}"] input[name="name"]`);
  again?.focus();
});

// Re-render on blur so DD values filled in from the table show up.
$("#groups").addEventListener("change", (e) => {
  if (["dd", "code", "dives"].includes(e.target.dataset.f)) renderGroupsKeepFocus();
});
function renderGroupsKeepFocus() {
  const a = document.activeElement;
  const sel = a && a.dataset && a.dataset.i !== undefined ? `[data-i="${a.dataset.i}"][data-f="${a.dataset.f}"]${a.dataset.r !== undefined ? `[data-r="${a.dataset.r}"]` : ""}` : null;
  renderGroups();
  if (sel) $(`#groups ${sel}`)?.focus();
}

$("#exportBtn").addEventListener("click", () => download(`${fileSafe(draft.name)}_divers.csv`, competitionDiversToCsv(draft.divers, draft.groups)));

// ---------- import ----------
function previewImport() {
  const text = $("#importText").value;
  importParsed = text.trim() ? parseImport(text) : null;
  if (importParsed) importParsed.warnings = importParsed.warnings.filter((w) => !/has no DD$/.test(w));
  const box = $("#importPreview");
  const n = importParsed?.divers.length || 0;
  $("#importGo").disabled = !n;
  $("#importGo").textContent = n ? `Import ${n} diver${n > 1 ? "s" : ""}` : "Import";
  if (!importParsed) return (box.innerHTML = "");
  const { divers, warnings } = importParsed;
  const groups = [...new Set(divers.map((d) => d.group).filter(Boolean))];
  const known = new Set(draft.groups.map((g) => g.name.trim().toLowerCase()));
  const fresh = groups.filter((g) => !known.has(g.toLowerCase()));
  box.innerHTML = `
    <p><b>${divers.length}</b> diver${divers.length === 1 ? "" : "s"} in <b>${groups.length}</b> group${groups.length === 1 ? "" : "s"}${
      fresh.length ? ` (new: ${fresh.map(esc).join(", ")})` : ""
    }${warnings.length ? `, <span class="warn-text">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</span>` : ""}.</p>
    ${warnings.length ? `<ul class="warnings">${warnings.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join("")}${warnings.length > 8 ? `<li>…and ${warnings.length - 8} more</li>` : ""}</ul>` : ""}
    ${divers.some((d) => !d.group) ? `<p class="warn-text small">Divers without a group are added under "Not in a group".</p>` : ""}
    <div class="order-wrap"><table class="order"><thead><tr><th>Name</th><th>Team</th><th>Group</th><th>Dives</th><th>Other dives</th></tr></thead><tbody>${divers
      .slice(0, 40)
      .map(
        (d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.team)}</td><td>${esc(d.group)}</td>
        <td class="mono">${d.dives.map((x) => (x ? `${esc(x.code)}${x.dd ? ` ${x.dd}` : ""}` : "—")).join(" · ")}</td><td class="mono">${esc((d.extra || []).join(" "))}</td></tr>`,
      )
      .join("")}${divers.length > 40 ? `<tr><td colspan="5" class="muted">…and ${divers.length - 40} more</td></tr>` : ""}</tbody></table></div>`;
}

async function loadFile(file) {
  if (!file) return;
  if (/\.xlsx?$/i.test(file.name)) return toast("Excel files: use File → Save as / Download → CSV, or copy the rows and paste them here");
  $("#importText").value = await file.text();
  previewImport();
}
$("#importBtn").addEventListener("click", () => {
  $("#importText").value = "";
  $("#importFile").value = "";
  previewImport();
  $("#importDlg").showModal();
});
$("#importText").addEventListener("input", previewImport);
$("#importFile").addEventListener("change", (e) => loadFile(e.target.files[0]));
const dz = $("#dropZone");
dz.addEventListener("dragover", (e) => (e.preventDefault(), dz.classList.add("over")));
dz.addEventListener("dragleave", () => dz.classList.remove("over"));
dz.addEventListener("drop", (e) => {
  e.preventDefault();
  dz.classList.remove("over");
  loadFile(e.dataTransfer.files[0]);
});
$("#importCancel").addEventListener("click", () => $("#importDlg").close());
$("#templateLink").addEventListener("click", (e) => {
  e.preventDefault();
  const groups = [
    { id: "a", name: "Girls 12–13" },
    { id: "b", name: "Boys 14–15" },
  ];
  const sample = [
    { name: "Ana Silva", team: "EDC", groupId: "a", dives: [{ code: "101B" }, { code: "201C" }, { code: "301C" }, { code: "401C" }], extra: ["103C"] },
    { name: "Mia Chen", team: "EDC", groupId: "a", dives: [{ code: "103C" }, { code: "201B" }, { code: "301B" }, { code: "401B" }], extra: [] },
    { name: "Tom Reid", team: "EDC", groupId: "b", dives: [{ code: "103B" }, { code: "203C" }, { code: "303C" }, { code: "403C" }], extra: ["5132D"] },
  ];
  download("competition_divers_template.csv", competitionDiversToCsv(sample, groups));
});

$("#importGo").addEventListener("click", () => {
  if (!importParsed?.divers.length) return;
  const replace = document.querySelector('input[name="importMode"]:checked').value === "replace";
  if (replace) draft.divers = [];
  const byName = new Map(draft.groups.map((g) => [g.name.trim().toLowerCase(), g]));
  for (const d of importParsed.divers) {
    let g = null;
    if (d.group) {
      g = byName.get(d.group.toLowerCase());
      if (!g) {
        g = addGroup(d.group);
        byName.set(d.group.toLowerCase(), g);
      }
    }
    draft.divers.push({
      id: newId("d"),
      name: d.name,
      team: d.team,
      groupId: g ? g.id : null,
      dives: d.dives.map((x) => x && { code: x.code, dd: x.dd || "", auto: !x.dd }),
      extra: d.extra || [],
    });
  }
  // New groups with a single platform: one leg covering every declared dive.
  for (const g of draft.groups) {
    if (g.legs.length === 1 && draft.platforms.length === 1 && g.legs[0].dives < defaultDives(g)) g.legs[0].dives = defaultDives(g);
    refreshGroup(g.id);
  }
  $("#importDlg").close();
  changed({ render: true });
  toast(`Imported ${importParsed.divers.length} divers. Set each group's rotation, then press Save setup`, 4000, true);
});

// ---------- warnings ----------
function cleanForSave() {
  return {
    name: draft.name,
    platforms: draft.platforms,
    judges: draft.judges,
    groups: draft.groups,
    divers: draft.divers.map((d) => ({
      id: d.id,
      name: d.name,
      team: d.team,
      groupId: d.groupId || null,
      extra: (d.extra || []).filter(Boolean),
      dives: d.dives.map((x) => (x && (x.code || Number(x.dd)) ? { code: x.code, dd: Number(x.dd) || 0, auto: !!x.auto } : null)),
    })),
  };
}

function renderWarnings() {
  let list;
  try {
    list = setupWarnings(normalizeSetup(cleanForSave())).map((w) => w.message);
  } catch (err) {
    list = [err instanceof SetupError ? `Can't save yet: ${err.message}` : String(err)];
  }
  $("#warnCard").hidden = !list.length;
  $("#warnList").innerHTML = list
    .slice(0, 12)
    .map((m) => `<li>${esc(m)}</li>`)
    .join("") + (list.length > 12 ? `<li>…and ${list.length - 12} more</li>` : "");
}

function renderAll() {
  $("#cName").value = draft.name;
  $("#compName").textContent = draft.name || "Competition";
  document.title = `${draft.name || "Competition"} · Setup`;
  renderPlatforms();
  renderJudges();
  renderGroups();
  renderWarnings();
}

// ---------- save ----------
function load(view) {
  version = view.version;

  saved = view.setup;
  draft = structuredClone(saved);
  for (const d of draft.divers) d.dives = d.dives.map((x) => x && { ...x });
  setDirty(false);
  renderShare();
  renderAll();
}

$("#saveBtn").addEventListener("click", async () => {
  let setup;
  try {
    setup = normalizeSetup(cleanForSave());
  } catch (err) {
    return toast(err.message, 5000);
  }
  saving = true;
  setDirty(true);
  try {
    load(await request("PUT", { version, setup }));
    $("#saveStatus").textContent = "Saved ✓";
    const s = store.get(`comp:${code}`) || {};
    store.set(`comp:${code}`, { ...s, key, name: draft.name, createdAt: s.createdAt || Date.now() });
  } catch (err) {
    saving = false;
    setDirty(true);
    if (err.status === 409) {
      if (await confirmDialog(`${err.message} Your unsaved changes will be lost.`, { ok: "Reload", danger: true })) load(err.data);
    } else toast(err.message, 5000);
    return;
  }
  saving = false;
  setDirty(false);
  $("#saveStatus").textContent = "Saved ✓";
});

$("#discardBtn").addEventListener("click", async () => {
  if (!(await confirmDialog("Discard your unsaved changes?", { ok: "Discard", danger: true }))) return;
  load({ version, setup: saved });
});

window.addEventListener("beforeunload", (e) => {
  if (dirty) e.preventDefault();
});

// ---------- start ----------
async function start(k) {
  key = k;
  const view = await request("GET");
  const s = store.get(`comp:${code}`) || {};
  store.set(`comp:${code}`, { ...s, key, name: view.setup.name, createdAt: s.createdAt || Date.now() });
  if (location.hash) history.replaceState(null, "", location.pathname + location.search);
  $("#codePill").textContent = code;
  $("#controlLink").href = `/control?c=${code}`;
  $("#noKey").classList.add("hidden");
  $("#app").hidden = false;
  load(view);
}

function askKey(msg) {
  $("#compName").textContent = "Competition setup";
  $("#noKey").classList.remove("hidden");
  $("#keyErr").textContent = msg || "";
}

$("#keyForm").addEventListener("submit", (e) => {
  e.preventDefault();
  start($("#keyInput").value.trim()).catch((err) => ($("#keyErr").textContent = err.message));
});

if (!code) location.href = "/";
const hashKey = new URLSearchParams(location.hash.slice(1)).get("key");
const initialKey = hashKey || store.get(`comp:${code}`)?.key;
if (initialKey) start(initialKey).catch((err) => askKey(err.status === 404 ? "Competition not found" : err.message));
else askKey();
