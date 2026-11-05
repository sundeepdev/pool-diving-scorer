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
    let done = false;
    const finish = (yes) => {
      if (done) return;
      done = true;
      resolve(yes);
    };
    // Answer on the click itself: the "close" event is queued and can arrive
    // seconds later in a background tab, after other actions were sent.
    dlg.querySelector("form").addEventListener("submit", (e) => finish(e.submitter?.value === "ok"));
    dlg.addEventListener("close", () => {
      dlg.remove();
      finish(dlg.returnValue === "ok");
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

// Self-healing WebSocket: reconnects with backoff, gives up on a connection
// attempt that hangs, detects dead connections (common on poolside Wi-Fi: the
// socket still looks open but nothing gets through) with a ping watchdog, and
// reconnects when the tab becomes visible again or the device comes back online.
//
// Meets pass code/role/judge/key, which go in the URL. Competitions pass
// `path` and a `hello()` function whose result is sent as the first message,
// so credentials stay out of the URL. Call stop() to give up reconnecting.
export const SOCKET_TIMING = { connectTimeout: 8000, pingEvery: 5000, deadAfter: 12000 };

export function liveSocket({ code, role, judge, key, path, hello, onState, onMessage, onStatus }) {
  let stopped = false;
  let ws = null;
  let retry = 0;
  let timer = null;
  let lastSeen = 0;
  let connectGuard = null;

  function open() {
    clearTimeout(timer);
    clearTimeout(connectGuard);
    if (ws) {
      ws.onclose = ws.onmessage = ws.onopen = null;
      try {
        ws.close();
      } catch {}
    }
    if (stopped) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    let url;
    if (path) url = `${proto}://${location.host}${path}`;
    else {
      const q = new URLSearchParams({ role });
      if (judge) q.set("judge", judge);
      if (key) q.set("key", key);
      url = `${proto}://${location.host}/api/meets/${code}/ws?${q}`;
    }
    const sock = (ws = new WebSocket(url));
    onStatus?.("connecting");
    // On bad Wi-Fi a connection attempt can hang for minutes without failing.
    connectGuard = setTimeout(() => {
      if (ws !== sock || sock.readyState !== WebSocket.CONNECTING) return;
      onStatus?.("offline");
      open();
    }, SOCKET_TIMING.connectTimeout);
    sock.onopen = () => {
      clearTimeout(connectGuard);
      retry = 0;
      lastSeen = Date.now();
      if (hello) sock.send(JSON.stringify(hello()));
      onStatus?.("online");
      // The server always answers a new connection with the state. If nothing
      // arrives, the link is dead even though it opened.
      connectGuard = setTimeout(() => {
        if (ws === sock && !heard) open();
      }, SOCKET_TIMING.connectTimeout);
    };
    let heard = false;
    sock.onmessage = (e) => {
      heard = true;
      clearTimeout(connectGuard);
      lastSeen = Date.now();
      if (e.data === "pong") return;
      const msg = JSON.parse(e.data);
      if (msg.type === "state") onState(msg.state);
      else onMessage?.(msg);
    };
    sock.onclose = () => {
      clearTimeout(connectGuard);
      if (stopped) return;
      onStatus?.("offline");
      timer = setTimeout(open, Math.min(8000, 400 * 2 ** retry++));
    };
  }

  setInterval(() => {
    if (stopped || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (Date.now() - lastSeen > SOCKET_TIMING.deadAfter) return open();
    ws.send("ping");
  }, SOCKET_TIMING.pingEvery);

  document.addEventListener("visibilitychange", () => {
    if (!stopped && !document.hidden && (!ws || ws.readyState !== WebSocket.OPEN || Date.now() - lastSeen > SOCKET_TIMING.deadAfter)) open();
  });
  window.addEventListener("online", () => !stopped && open());

  open();
  return {
    stop() {
      stopped = true;
      clearTimeout(timer);
      clearTimeout(connectGuard);
      try {
        ws?.close();
      } catch {}
    },
    reconnect: () => open(),
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
