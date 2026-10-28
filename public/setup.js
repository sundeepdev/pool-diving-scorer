// "Competition setup" tab: event details, diver list editor, CSV import/export.
// Edits are kept in a local draft and sent to the meet when the referee saves.
import { $, esc } from "/common.js";
import { describeDive } from "/dives.js";
import { diversToCsv, parseImport } from "/importer.js";

const CODE_RE = /^\d{3,4}[A-D]$/i;
const validCode = (c) => !c || CODE_RE.test(c);
const validDD = (dd) => dd === "" || dd === null || dd === undefined || dd === 0 || (Number(dd) > 0 && Number(dd) <= 5);

function download(name, text, type = "text/csv") {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

const fileSafe = (s) => String(s || "meet").replace(/[^\w-]+/g, "_");

export function createSetup({ send, toast, onDirtyChange }) {
  let latest = null; // last state from the server
  let draft = null;
  let dirty = false;
  let savingRef = null;
  let importParsed = null;

  const fromState = (s) => ({
    name: s.name,
    event: s.event || "",
    judges: s.judges,
    rounds: s.rounds,
    autoReveal: s.autoReveal,
    divers: structuredClone(s.divers),
  });

  function setDirty(v) {
    dirty = v;
    $("#saveBtn").disabled = !v || !!savingRef;
    $("#discardBtn").hidden = !v;
    $("#saveStatus").textContent = savingRef ? "Saving…" : v ? "Unsaved changes" : "All changes saved";
    $("#saveStatus").className = v ? "warn-text" : "muted";
    $("#savebar").classList.toggle("dirty", v);
    onDirtyChange?.(v);
  }

  // ---------- competition details ----------
  function renderDetails() {
    $("#sName").value = draft.name;
    $("#sEvent").value = draft.event;
    $("#sJudges").value = String(draft.judges);
    $("#sRounds").value = draft.rounds;
    $("#sAuto").checked = draft.autoReveal;
  }
  for (const [id, key, conv] of [
    ["#sName", "name", String],
    ["#sEvent", "event", String],
    ["#sJudges", "judges", Number],
    ["#sAuto", "autoReveal", null],
  ]) {
    $(id).addEventListener("input", (e) => {
      draft[key] = conv ? conv(e.target.value) : e.target.checked;
      setDirty(true);
    });
  }
  $("#sRounds").addEventListener("input", (e) => {
    const r = Math.round(Number(e.target.value));
    if (!(r >= 1 && r <= 12)) return;
    draft.rounds = r;
    setDirty(true);
    renderTable();
  });

  // ---------- diver table ----------
  const scoredCount = (id) => (latest ? Object.keys(latest.results).filter((k) => k.startsWith(`${id}:`)).length : 0);

  function renderTable() {
    const n = draft.rounds;
    $("#diverCount").textContent = draft.divers.length ? `(${draft.divers.length})` : "";
    const head = `<thead><tr><th>#</th><th>Diver</th><th>Team / club</th>${Array.from({ length: n }, (_, r) => `<th>Round ${r + 1}<span class="sub">Dive · DD</span></th>`).join("")}<th></th></tr></thead>`;
    const body = draft.divers
      .map((d, i) => {
        const scored = d.id ? scoredCount(d.id) : 0;
        const cells = Array.from({ length: n }, (_, r) => {
          const dv = d.dives[r] || { code: "", dd: "" };
          const code = dv.code || "";
          const dd = typeof dv.dd === "number" && dv.dd ? dv.dd.toFixed(1) : dv.dd || "";
          return `<td class="dive-cell"><div class="pair">
              <input class="code ${validCode(code) ? "" : "invalid"}" data-i="${i}" data-r="${r}" data-f="code" value="${esc(code)}" placeholder="dive" maxlength="5" autocapitalize="characters" autocomplete="off" aria-label="${esc(d.name)} round ${r + 1} dive">
              <input class="ddin ${validDD(dd) ? "" : "invalid"}" data-i="${i}" data-r="${r}" data-f="dd" value="${esc(dd)}" placeholder="DD" inputmode="decimal" maxlength="4" autocomplete="off" aria-label="${esc(d.name)} round ${r + 1} DD">
            </div><div class="desc" data-desc="${i}:${r}">${esc(describeDive(code))}</div></td>`;
        }).join("");
        return `<tr>
          <td class="num">${i + 1}${scored ? `<span class="scored" title="${scored} dive(s) already scored">${scored}✓</span>` : ""}</td>
          <td><input data-i="${i}" data-f="name" value="${esc(d.name)}" maxlength="60" class="${d.name.trim() ? "" : "invalid"}" aria-label="Diver ${i + 1} name"></td>
          <td><input data-i="${i}" data-f="team" value="${esc(d.team)}" maxlength="40" aria-label="Diver ${i + 1} team"></td>
          ${cells}
          <td class="acts">
            <button type="button" class="icon-btn" data-act="up" data-i="${i}" title="Move up" ${i === 0 ? "disabled" : ""}>↑</button>
            <button type="button" class="icon-btn" data-act="down" data-i="${i}" title="Move down" ${i === draft.divers.length - 1 ? "disabled" : ""}>↓</button>
            <button type="button" class="icon-btn del" data-act="remove" data-i="${i}" title="Remove diver">✕</button>
          </td></tr>`;
      })
      .join("");
    $("#diversTable").innerHTML =
      head + `<tbody>${body || `<tr><td colspan="${n + 4}" class="empty">No divers yet — add them below or use <b>Import…</b></td></tr>`}</tbody>`;
  }

  $("#diversTable").addEventListener("input", (e) => {
    const el = e.target;
    const i = Number(el.dataset.i);
    const d = draft.divers[i];
    if (!d) return;
    const f = el.dataset.f;
    if (f === "name" || f === "team") {
      d[f] = el.value;
      if (f === "name") el.classList.toggle("invalid", !el.value.trim());
    } else {
      const r = Number(el.dataset.r);
      while (d.dives.length <= r) d.dives.push(null);
      const dive = (d.dives[r] ||= { code: "", dd: "" });
      if (f === "code") {
        const pos = el.selectionStart;
        el.value = el.value.toUpperCase();
        el.setSelectionRange(pos, pos);
        dive.code = el.value.trim();
        el.classList.toggle("invalid", !validCode(dive.code));
        $(`[data-desc="${i}:${r}"]`).textContent = describeDive(dive.code);
      } else {
        dive.dd = el.value.trim().replace(",", ".");
        el.classList.toggle("invalid", !validDD(dive.dd));
      }
    }
    setDirty(true);
  });

  $("#diversTable").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]");
    if (!b) return;
    const i = Number(b.dataset.i);
    const list = draft.divers;
    if (b.dataset.act === "up" && i > 0) [list[i - 1], list[i]] = [list[i], list[i - 1]];
    else if (b.dataset.act === "down" && i < list.length - 1) [list[i + 1], list[i]] = [list[i], list[i + 1]];
    else if (b.dataset.act === "remove") {
      const d = list[i];
      const scored = d.id ? scoredCount(d.id) : 0;
      if (!confirm(scored ? `${d.name} already has ${scored} scored dive(s). Remove them and their scores?` : `Remove ${d.name || "this diver"}?`)) return;
      list.splice(i, 1);
    } else return;
    setDirty(true);
    renderTable();
  });

  $("#addForm").addEventListener("submit", (e) => {
    e.preventDefault();
    const name = $("#addName").value.trim();
    if (!name) return $("#addName").focus();
    draft.divers.push({ name, team: $("#addTeam").value.trim(), dives: [] });
    $("#addName").value = "";
    setDirty(true);
    renderTable();
    $("#addName").focus();
    $("#diversTable tbody tr:last-child")?.scrollIntoView({ block: "nearest" });
  });

  $("#drawBtn").addEventListener("click", () => {
    if (draft.divers.length < 2 || !confirm("Randomly draw a new diving order?")) return;
    const a = draft.divers;
    for (let i = a.length - 1; i > 0; i--) {
      const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    setDirty(true);
    renderTable();
  });

  $("#clearBtn").addEventListener("click", () => {
    if (!draft.divers.length || !confirm("Remove ALL divers (and any scores they have)?")) return;
    draft.divers = [];
    setDirty(true);
    renderTable();
  });

  $("#exportBtn").addEventListener("click", () => download(`${fileSafe(draft.name)}_divers.csv`, diversToCsv(draft.divers, draft.rounds)));

  // ---------- import ----------
  function previewImport() {
    const text = $("#importText").value;
    importParsed = text.trim() ? parseImport(text) : null;
    const box = $("#importPreview");
    $("#importGo").disabled = !importParsed?.divers.length;
    $("#importGo").textContent = importParsed?.divers.length ? `Import ${importParsed.divers.length} diver${importParsed.divers.length > 1 ? "s" : ""}` : "Import";
    if (!importParsed) return (box.innerHTML = "");
    const { divers, warnings } = importParsed;
    box.innerHTML = `
      <p><b>${divers.length}</b> diver${divers.length === 1 ? "" : "s"} found${warnings.length ? `, <span class="warn-text">${warnings.length} warning${warnings.length > 1 ? "s" : ""}</span>` : ""}.</p>
      ${warnings.length ? `<ul class="warnings">${warnings.slice(0, 8).map((w) => `<li>${esc(w)}</li>`).join("")}${warnings.length > 8 ? `<li>…and ${warnings.length - 8} more</li>` : ""}</ul>` : ""}
      ${divers.length ? `<div class="order-wrap"><table class="order"><thead><tr><th>Name</th><th>Team</th><th>Dives</th></tr></thead><tbody>${divers
        .slice(0, 30)
        .map((d) => `<tr><td>${esc(d.name)}</td><td>${esc(d.team)}</td><td class="mono">${d.dives.map((x) => (x ? `${esc(x.code)} ${x.dd || "?"}` : "—")).join(" · ")}</td></tr>`)
        .join("")}${divers.length > 30 ? `<tr><td colspan="3" class="muted">…and ${divers.length - 30} more</td></tr>` : ""}</tbody></table></div>` : ""}`;
  }

  function openImport() {
    $("#importText").value = "";
    $("#importFile").value = "";
    previewImport();
    $("#importDlg").showModal();
  }
  async function loadFile(file) {
    if (!file) return;
    if (/\.xlsx?$/i.test(file.name)) return toast("Excel files: use File → Save as / Download → CSV, or copy the rows and paste them here");
    $("#importText").value = await file.text();
    previewImport();
  }
  $("#importBtn").addEventListener("click", openImport);
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
    const sample = [
      { name: "Ana Silva", team: "BRA", dives: [{ code: "105B", dd: 2.4 }, { code: "203C", dd: 2.0 }, { code: "305C", dd: 3.0 }] },
      { name: "Mia Chen", team: "CHN", dives: [{ code: "107B", dd: 3.1 }, { code: "205B", dd: 3.0 }, { code: "307C", dd: 3.5 }] },
    ];
    download("divers_template.csv", diversToCsv(sample, Math.max(3, draft.rounds)));
  });
  $("#importGo").addEventListener("click", () => {
    if (!importParsed?.divers.length) return;
    const replace = document.querySelector('input[name="importMode"]:checked').value === "replace";
    const incoming = importParsed.divers.map((d) => ({ ...d, dives: d.dives.map((x) => x && { code: x.code, dd: x.dd || "" }) }));
    if (replace) {
      // Re-importing a corrected list keeps scores for divers with the same name.
      const byName = new Map(draft.divers.filter((d) => d.id).map((d) => [d.name.trim().toLowerCase(), d.id]));
      for (const d of incoming) d.id = byName.get(d.name.toLowerCase());
      draft.divers = incoming;
    } else draft.divers.push(...incoming);
    const most = Math.max(0, ...incoming.map((d) => d.dives.length));
    if (most > draft.rounds) draft.rounds = Math.min(12, most);
    $("#importDlg").close();
    setDirty(true);
    renderDetails();
    renderTable();
    toast(`Imported ${incoming.length} diver${incoming.length > 1 ? "s" : ""} — review and press Save setup`, 3500, true);
  });

  // ---------- save ----------
  function problems() {
    const out = [];
    draft.divers.forEach((d, i) => {
      if (!d.name.trim()) out.push(`Diver #${i + 1} has no name`);
      d.dives.slice(0, draft.rounds).forEach((x, r) => {
        if (x && !validCode(x.code)) out.push(`${d.name || `Diver #${i + 1}`}, round ${r + 1}: "${x.code}" isn't a dive number`);
        if (x && !validDD(x.dd)) out.push(`${d.name || `Diver #${i + 1}`}, round ${r + 1}: DD "${x.dd}" isn't valid`);
      });
    });
    return out;
  }

  $("#saveBtn").addEventListener("click", () => {
    const errs = problems();
    if (errs.length) return toast(errs[0] + (errs.length > 1 ? ` (+${errs.length - 1} more)` : ""), 5000);
    if (draft.judges !== latest.judges && latest.current?.phase === "scoring" && !confirm("Changing the number of judges clears scores for the dive being judged. Continue?")) return;
    const ref = Date.now();
    const ok = send({
      type: "setup",
      ref,
      name: draft.name,
      event: draft.event,
      judges: draft.judges,
      rounds: draft.rounds,
      autoReveal: draft.autoReveal,
      divers: draft.divers.map((d) => ({
        id: d.id,
        name: d.name,
        team: d.team,
        dives: d.dives.slice(0, draft.rounds).map((x) => (x && (x.code || Number(x.dd)) ? { code: x.code, dd: Number(x.dd) || 0 } : null)),
      })),
    });
    if (!ok) return;
    savingRef = ref;
    setDirty(true);
  });

  $("#discardBtn").addEventListener("click", () => {
    if (!confirm("Discard your unsaved setup changes?")) return;
    draft = fromState(latest);
    setDirty(false);
    renderDetails();
    renderTable();
  });

  window.addEventListener("beforeunload", (e) => {
    if (dirty) e.preventDefault();
  });

  return {
    onState(s) {
      const first = !latest;
      latest = s;
      if (first || (!dirty && !savingRef)) {
        draft = fromState(s);
        renderDetails();
        renderTable();
      } else if (!$("#diversTable").contains(document.activeElement)) renderTable(); // refresh "scored" badges
    },
    onAck(ref) {
      if (ref !== savingRef) return;
      savingRef = null;
      draft = fromState(latest);
      setDirty(false);
      renderDetails();
      renderTable();
      $("#saveStatus").textContent = "Saved ✓";
    },
    onError(msg) {
      if (msg.ref === undefined || msg.ref !== savingRef) return false;
      savingRef = null;
      setDirty(true);
      toast(msg.message, 5000);
      return true;
    },
    get dirty() {
      return dirty;
    },
  };
}
