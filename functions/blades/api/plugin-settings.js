// Cloudflare Pages Function — per-pilot Companion settings (the MY STATS panel).
//
// The MY STATS "Companion" panel reads + writes these; the Blades Registrar plugin
// picks them up on its existing nav poll (navpull) and applies them LIVE — no EDMC
// restart. Stored in KV "plugin:settings" as { cmdrLower: { autocreate, honk } }.
// Access-gated + resolved to the caller's bound CMDR, so a pilot only ever edits
// their own settings.
//
// GET  /blades/api/plugin-settings  -> { ok, cmdr, settings:{autocreate,honk}, needsSetup? }
// POST /blades/api/plugin-settings  { autocreate?, honk? } -> { ok, cmdr, settings }
// ⚠⚠ MIRRORED in functions/ingest/navpull.js -> settingsFor(). Both lists must match or a
// setting saves here and never reaches the plugin, silently. Cost one wrong conclusion on
// 2026-08-10 ("background refocus is impossible on this rig" — it was simply never on).
const ALLOWED = ["autocreate", "honk", "galaxymap", "fuel", "pirate", "refocus"];
const DEFAULTS = { autocreate: false, honk: false, galaxymap: false, fuel: false, pirate: false, refocus: false };
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
function pubSettings(rec) {
  const out = Object.assign({}, DEFAULTS);
  if (rec && typeof rec === "object") for (const k of ALLOWED) if (typeof rec[k] === "boolean") out[k] = rec[k];
  return out;
}
// Per-assist readiness the plugin reported on its heartbeat (KV plugin:readiness:{cmdr},
// written by /ingest/navpull). Shape { honk:{ready,missing:[]}, galaxymap:{...} }. Absent
// for pilots on an older plugin that doesn't report — the panel then just shows no readiness
// state, exactly as before (safe dark-launch on the shared shell).
const READY_ASSISTS = ["honk", "galaxymap"];
function pubReadiness(rec) {
  const src = (rec && rec.assists && typeof rec.assists === "object") ? rec.assists : null;
  if (!src) return {};
  const out = {};
  for (const k of READY_ASSISTS) {
    const v = src[k];
    if (!v || typeof v !== "object") continue;
    const missing = Array.isArray(v.missing) ? v.missing.filter(x => typeof x === "string") : [];
    out[k] = { ready: !!v.ready, missing: v.ready ? [] : missing };
  }
  return out;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  if (!cmdr) return json({ ok: true, cmdr: "", settings: pubSettings(null), needsSetup: true });
  const key = cmdr.toLowerCase();
  const map = await readJson(env, "plugin:settings");
  const rdy = await readJson(env, "plugin:readiness:" + key);
  return json({ ok: true, cmdr, settings: pubSettings(map && map[key]), readiness: pubReadiness(rdy) });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  if (!cmdr) return json({ ok: false, error: "bind your CMDR first", needsSetup: true }, 400);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const key = cmdr.toLowerCase();
  const map = (await readJson(env, "plugin:settings")) || {};
  const rec = Object.assign({}, DEFAULTS, (map[key] && typeof map[key] === "object") ? map[key] : {});
  let touched = false;
  for (const k of ALLOWED) {
    if (k in body) { rec[k] = !!body[k]; touched = true; }
  }
  if (!touched) return json({ ok: false, error: "no valid setting in body (" + ALLOWED.join("|") + ")" }, 400);
  const saved = {};
  for (const k of ALLOWED) saved[k] = !!rec[k];   // persist EVERY allowed key, not just the first two
  map[key] = saved;
  try { await env.BUILDS.put("plugin:settings", JSON.stringify(map)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, cmdr, settings: pubSettings(map[key]) });
}
