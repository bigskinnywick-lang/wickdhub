// Cloudflare Pages Function — the signed-in pilot's LIVE telemetry for the MY DASHBOARD
// tile row (system, ship, fuel %, cargo, flight state).
//
// The Blades Registrar plugin reports telemetry on its navpull heartbeat; /ingest/navpull
// stores it at KV "plugin:telemetry:{cmdr}" with a short TTL. This endpoint resolves the
// caller (Access JWT) -> their bound CMDR -> their own telemetry, and returns how old it is
// so the tile row can show a liveness heartbeat and go "offline" (grey) when the plugin
// isn't running. Per-pilot, self only — a pilot only ever sees their own cockpit here.
//
// GET /blades/api/telemetry (Access-gated, no-store)
//   -> { ok, cmdr, telemetry:{sys,ship,shipName,fuelPct,cargo,cargoCap,status}|null, ts, ageMs }
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
}
async function readJson(env, key) { try { const v = await env.BUILDS.get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
async function resolveCmdr(env, email) { const o = await readJson(env, "cmdrlink:" + email); return (o && o.cmdr) ? String(o.cmdr) : ""; }

// Whitelist the fields the tile row renders so a bad KV value can't reach the page.
function pubTelemetry(rec) {
  const t = (rec && rec.telemetry && typeof rec.telemetry === "object") ? rec.telemetry : null;
  if (!t) return null;
  const out = {};
  for (const k of ["sys", "ship", "shipName", "status"]) if (typeof t[k] === "string") out[k] = t[k];
  for (const k of ["fuelPct", "cargo", "cargoCap"]) if (typeof t[k] === "number") out[k] = t[k];
  return Object.keys(out).length ? out : null;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  if (!cmdr) return json({ ok: true, cmdr: "", telemetry: null, ts: 0, ageMs: null, needsSetup: true });
  const rec = await readJson(env, "plugin:telemetry:" + cmdr.toLowerCase());
  const ts = (rec && typeof rec.ts === "number") ? rec.ts : 0;
  const ageMs = ts ? Math.max(0, Date.now() - ts) : null;
  return json({ ok: true, cmdr, telemetry: pubTelemetry(rec), ts, ageMs });
}
