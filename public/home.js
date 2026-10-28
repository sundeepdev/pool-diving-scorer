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

const mine = [];
for (let i = 0; i < localStorage.length; i++) {
  const k = localStorage.key(i);
  if (k?.startsWith("ref:")) mine.push({ code: k.slice(4), ...store.get(k) });
}
if (mine.length) {
  mine.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  $("#myMeets").hidden = false;
  $("#myMeetsList").innerHTML = mine
    .map((m) => `<li><span><b class="mono">${esc(m.code)}</b> · ${esc(m.name || "")}</span><span>
      <a href="/referee?meet=${esc(m.code)}">Control</a> · <a href="/live?meet=${esc(m.code)}">Scoreboard</a></span></li>`)
    .join("");
}
