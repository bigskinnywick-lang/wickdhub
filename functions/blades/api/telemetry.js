// Cloudflare Pages Function — the signed-in pilot's LIVE telemetry for the MY DASHBOARD
// tile row (system, ship, fuel %, cargo, flight state).
//
// The Blades Registrar plugin reports telemetry on its navpull heartbeat; /ingest/navpull
// stores it at KV "plugin:telemetry:{cmdr}" with a short TTL. This endpoint resolves the
// caller (Access JWT) -> their bound CMDR -> their own telemetry, and returns how old it is
// so the tile row can show a liveness heartbeat and go "offline" (grey) when the plugin
// isn't running. Per-pilot, self only — a pilot only ever sees their own cockpit here.
//
// It also carries the pilot's ALERTS (pirate scan, fuel low, …) from the same heartbeat, so
// the dashboard has ONE poll for its whole live state rather than an endpoint per card.
//
// GET /blades/api/telemetry (Access-gated, no-store)
//   -> { ok, cmdr, telemetry:{sys,ship,shipName,fuelPct,cargo,cargoCap,status}|null, ts, ageMs,
//        alerts:[{id,level,msg,ts}] }
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

// Whitelist the alert fields the strip renders, newest FIRST, capped. An unknown level is
// forced to "info" so a bad KV value can never paint (or sound) as critical.
const ALERT_LEVELS = { critical: 1, warn: 1, info: 1 };
const ALERTS_SHOW = 8;
function pubAlerts(rec) {
  const src = Array.isArray(rec && rec.alerts) ? rec.alerts : [];
  const out = [];
  for (const a of src) {
    if (!a || typeof a !== "object") continue;
    if (typeof a.id !== "string" || typeof a.msg !== "string" || !a.msg) continue;
    const lvl = String(a.level || "info").toLowerCase();
    out.push({
      id: a.id.slice(0, 40),
      level: ALERT_LEVELS[lvl] ? lvl : "info",
      msg: a.msg.slice(0, 120),
      ts: (typeof a.ts === "number" && Number.isFinite(a.ts)) ? a.ts : 0
    });
  }
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));   // newest first — the strip reads top-down
  return out.slice(0, ALERTS_SHOW);
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  if (!cmdr) return json({ ok: true, cmdr: "", telemetry: null, ts: 0, ageMs: null, alerts: [], needsSetup: true });
  const key = cmdr.toLowerCase();
  const rec = await readJson(env, "plugin:telemetry:" + key);
  const alr = await readJson(env, "plugin:alerts:" + key);
  const ts = (rec && typeof rec.ts === "number") ? rec.ts : 0;
  const ageMs = ts ? Math.max(0, Date.now() - ts) : null;
  return json({ ok: true, cmdr, telemetry: pubTelemetry(rec), ts, ageMs, alerts: pubAlerts(alr) });
}
