export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}

export const fmtScore = (v) => (v === null || v === undefined ? "–" : Number(v).toFixed(1));
export const fmtPts = (v) => Number(v || 0).toFixed(2);
export const fmtDD = (v) => (v ? Number(v).toFixed(1) : "–");
export function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function meetCodeFromUrl() {
  return (new URLSearchParams(location.search).get("meet") || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 6);
}

export const store = {
  get(key) {
    try {
      return JSON.parse(localStorage.getItem(key));
    } catch {
      return null;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
  remove(key) {
    try {
      localStorage.removeItem(key);
    } catch {}
  },
};

// In-page replacement for window.confirm(). In-app browsers (links opened from
// chat apps) and embedded webviews often suppress native dialogs, so confirm()
// returns false without showing anything and the action silently does nothing.
export function confirmDialog(message, { ok = "OK", danger = false } = {}) {
  const dlg = document.createElement("dialog");
  dlg.innerHTML = `<form method="dialog">
    <p style="margin:0 0 16px;font-size:17px">${esc(message)}</p>
    <div class="row"><button class="btn" value="cancel">Cancel</button><button class="btn ${danger ? "danger" : "primary"}" value="ok">${esc(ok)}</button></div>
  </form>`;
  document.body.append(dlg);
  return new Promise((resolve) => {
    dlg.addEventListener("close", () => {
      dlg.remove();
      resolve(dlg.returnValue === "ok");
    });
    dlg.showModal();
  });
}

export async function api(path, body) {
  const res = await fetch(path, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {});
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { status: res.status });
  return data;
}

// Self-healing WebSocket: reconnects with backoff, detects dead connections
// (common on poolside Wi-Fi) with a ping watchdog, and reconnects when the
// tab becomes visible again.
export function liveSocket({ code, role, judge, key, onState, onMessage, onStatus }) {
  let ws = null;
  let retry = 0;
  let timer = null;
  let lastSeen = 0;

  function open() {
    clearTimeout(timer);
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try {
        ws.close();
      } catch {}
    }
    const q = new URLSearchParams({ role });
    if (judge) q.set("judge", judge);
    if (key) q.set("key", key);
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = (ws = new WebSocket(`${proto}://${location.host}/api/meets/${code}/ws?${q}`));
    onStatus?.("connecting");
    sock.onopen = () => {
      retry = 0;
      lastSeen = Date.now();
      onStatus?.("online");
    };
    sock.onmessage = (e) => {
      lastSeen = Date.now();
      if (e.data === "pong") return;
      const msg = JSON.parse(e.data);
      if (msg.type === "state") onState(msg.state);
      else onMessage?.(msg);
    };
    sock.onclose = () => {
      onStatus?.("offline");
      timer = setTimeout(open, Math.min(8000, 400 * 2 ** retry++));
    };
  }

  setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSeen > 30000) return open();
    ws.send("ping");
  }, 10000);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden && (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastSeen > 15000)) open();
  });
  window.addEventListener("online", () => open());

  open();
  return {
    send(obj) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(obj));
        return true;
      }
      return false;
    },
    get isOpen() {
      return !!ws && ws.readyState === WebSocket.OPEN;
    },
  };
}

export function diverById(state, id) {
  return state.divers.find((d) => d.id === id);
}
