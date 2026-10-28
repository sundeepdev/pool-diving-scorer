export { Meet } from "./meet.js";

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return Array.from(bytes, (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

const meetStub = (env, code) => env.MEET.get(env.MEET.idFromName(code));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/meets" && request.method === "POST") {
      const cfg = await request.json().catch(() => ({}));
      for (let attempt = 0; attempt < 5; attempt++) {
        const code = newCode();
        try {
          const res = await meetStub(env, code).create(code, cfg);
          if (!res.error) return json(res, 201);
        } catch (err) {
          return json({ error: err.message || "Invalid meet setup" }, 400);
        }
      }
      return json({ error: "Could not allocate a meet code, try again" }, 503);
    }

    const m = url.pathname.match(/^\/api\/meets\/([A-Za-z0-9]{6})(?:\/(ws|auth))?$/);
    if (m) {
      const code = m[1].toUpperCase();
      const stub = meetStub(env, code);
      if (m[2] === "ws") return stub.fetch(request);
      if (m[2] === "auth" && request.method === "POST") {
        const { role, judge, key } = await request.json().catch(() => ({}));
        const res = await stub.auth(role, Number(judge), key);
        return json(res, res.ok ? 200 : res.error === "Meet not found" ? 404 : 403);
      }
      const summary = await stub.summary();
      return summary ? json(summary) : json({ error: "Meet not found" }, 404);
    }

    if (url.pathname.startsWith("/api/")) return json({ error: "Not found" }, 404);
    return env.ASSETS.fetch(request);
  },
};
