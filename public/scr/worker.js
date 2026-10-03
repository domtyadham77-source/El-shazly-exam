// Cloudflare Worker: serves the exam page (static assets) and the 3 API routes.
// Secrets/variables it reads (Cloudflare dashboard > your Worker > Settings > Variables and Secrets):
//   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN   (from your Upstash database)  [required]
//   TEACHER_PASSWORD                                    [optional, default below]
//   LICENSE_UNTIL (in wrangler.toml), LICENSE_ACTIVE ("false" closes the site immediately) [optional]

const DEFAULT_PASSWORD = "mr.Mohamed El-Shazly";

const J = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });

/* ---------- Redis (Upstash REST) ---------- */
async function call(env, path, body) {
  const base = String(env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL || "").replace(/\/$/, "");
  const token = env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN;
  if (!base || !token) throw new Error("Redis is not connected to this Worker");
  const r = await fetch(base + path, {
    method: "POST",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j && j.error) || "redis error");
  return j;
}

async function redis(env, cmd) {
  const j = await call(env, "", cmd);
  if (j.error) throw new Error(j.error);
  return j.result;
}

async function pipeline(env, cmds) {
  const j = await call(env, "/pipeline", cmds);
  return j.map((x) => { if (x.error) throw new Error(x.error); return x.result; });
}

/* ---------- POST /api/submit : a result or a photo of a written answer ---------- */
async function submit(request, env) {
  if (request.method !== "POST") return J({ error: "POST only" }, 405);
  let b;
  try { b = await request.json(); } catch (e) { return J({ error: "bad request" }, 400); }
  b = b || {};
  const name = String(b.student || "").trim().slice(0, 120);
  const num = String(b.num || "").trim().slice(0, 30);
  const cls = String(b.cls || "").trim().slice(0, 40);
  if (!name || !num || !cls) return J({ error: "missing name, number or class" }, 400);
  const key = cls + "|" + num;

  if (b.type === "photo") {
    const q = Number(b.question) === 2 ? 2 : 1;
    const img = String(b.image || "");
    if (!img.startsWith("data:image/") || img.length > 900000) return J({ error: "bad or too large image" }, 400);
    await redis(env, ["RPUSH", "photos:" + key + ":" + q, img]);
  } else if (b.type === "result") {
    const row = {
      name, num, cls,
      phone: String(b.phone || "").replace(/[^+\d]/g, "").slice(0, 20),
      correct: Number(b.correct) || 0,
      total: Number(b.total) || 0,
      answered: Number(b.answered) || 0,
      left: Number(b.left) || 0,
      at: Date.now(),
    };
    await redis(env, ["HSET", "results", key, JSON.stringify(row)]);
  } else {
    return J({ error: "unknown type" }, 400);
  }

  return J({ ok: true });
}

/* ---------- GET /api/results : teacher only ---------- */
const norm = (x) => String(x || "").normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();

async function results(request, env) {
  let given = String(request.headers.get("x-teacher-password") || "");
  try { given = decodeURIComponent(given); } catch (e) {}
  const real = norm(env.TEACHER_PASSWORD || DEFAULT_PASSWORD);
  if (norm(given) !== real) return J({ error: "wrong password" }, 401);

  const url = new URL(request.url);
  const k = url.searchParams.get("photos");
  if (k) {
    const [a, b] = await pipeline(env, [
      ["LRANGE", "photos:" + k + ":1", 0, -1],
      ["LRANGE", "photos:" + k + ":2", 0, -1],
    ]);
    return J({ photos: [a || [], b || []] });
  }

  const raw = (await redis(env, ["HGETALL", "results"])) || [];
  const flat = Array.isArray(raw) ? raw : Object.entries(raw).flat();
  const rows = [];
  for (let i = 0; i < flat.length; i += 2) {
    try { const r = JSON.parse(flat[i + 1]); r.key = flat[i]; rows.push(r); } catch (e) {}
  }

  if (rows.length) {
    const counts = await pipeline(env, rows.flatMap((r) => [["LLEN", "photos:" + r.key + ":1"], ["LLEN", "photos:" + r.key + ":2"]]));
    rows.forEach((r, i) => { r.pc = [counts[i * 2] || 0, counts[i * 2 + 1] || 0]; });
  }

  return J({ rows });
}

/* ---------- GET /api/license : is the subscription still valid? (server clock decides) ---------- */
function license(request, env) {
  const until = String(env.LICENSE_UNTIL || "2026-10-10").trim();
  const active = String(env.LICENSE_ACTIVE || "true").toLowerCase() !== "false";
  const endsAt = new Date(until + "T23:59:59+03:00").getTime();   // end of that day, Cairo time
  return J({ active, until, expired: !(Date.now() <= endsAt) });
}

export default {
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/api/submit") return await submit(request, env);
      if (pathname === "/api/results") return await results(request, env);
      if (pathname === "/api/license") return license(request, env);
      if (pathname.startsWith("/api/")) return J({ error: "not found" }, 404);
    } catch (e) {
      return J({ error: "server error" }, 500);
    }
    return env.ASSETS.fetch(request);   // everything else: the exam page
  },
};
