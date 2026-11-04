import { $, api, esc, store } from "/common.js";

const clean = (v) => v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
for (const id of ["jCode", "wCode"]) $(`#${id}`).addEventListener("input", (e) => (e.target.value = clean(e.target.value)));

$("#judgeForm").addEventListener("submit", (e) => {
  e.preventDefault();
  location.href = `/judge?meet=${clean($("#jCode").value)}`;
});
$("#watchForm").addEventListener("submit", (e) => {
  e.preventDefault();
  location.href = `/live?meet=${clean($("#wCode").value)}`;
});

$("#createForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $("#createErr").textContent = "";
  try {
    const res = await api("/api/meets", {
      name: $("#cName").value,
      judges: Number($("#cJudges").value),
      rounds: Number($("#cRounds").value),
      event: $("#cEvent").value,
      autoReveal: $("#cAuto").checked,
    });
    store.set(`ref:${res.code}`, { key: res.adminKey, name: $("#cName").value, createdAt: Date.now() });
    location.href = `/referee?meet=${res.code}`;
  } catch (err) {
    $("#createErr").textContent = err.message;
    btn.disabled = false;
  }
});

$("#compForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  btn.disabled = true;
  $("#compErr").textContent = "";
  try {
    const res = await api("/api/competitions", { name: $("#compName").value });
    store.set(`comp:${res.code}`, { key: res.adminKey, name: $("#compName").value, createdAt: Date.now() });
    location.href = `/competition?c=${res.code}`;
  } catch (err) {
    $("#compErr").textContent = err.message;
    btn.disabled = false;
  }
});

const mine = [];
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (k?.startsWith("ref:")) mine.push({ code: k.slice(4), kind: "meet", ...store.get(k) });
  if (k?.startsWith("comp:")) mine.push({ code: k.slice(5), kind: "competition", ...store.get(k) });
}
if (mine.length) {
  mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $("#myMeets").hidden = false;
  $("#myMeetsList").innerHTML = mine
    .map((m) =>
      m.kind === "competition"
        ? `<li><span><b class="mono">${esc(m.code)}</b> · ${esc(m.name || "")} <span class="muted small">(competition)</span></span><span>
      <a href="/competition?c=${esc(m.code)}">Setup</a></span></li>`
        : `<li><span><b class="mono">${esc(m.code)}</b> · ${esc(m.name || "")}</span><span>
      <a href="/referee?meet=${esc(m.code)}">Control</a> · <a href="/live?meet=${esc(m.code)}">Scoreboard</a></span></li>`,
    )
    .join("");
}
