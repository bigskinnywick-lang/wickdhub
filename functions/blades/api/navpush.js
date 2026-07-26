// Cloudflare Pages Function — "nav push" from the board to a commander's own PC clipboard.
//
// Tablet/phone browsers can't write the PC clipboard, so the board can't hand a
// system name to the game that way. Instead the board POSTs the target here, keyed
// to the caller's OWN commander, and the Blades Registrar plugin (running on that
// commander's PC) polls /ingest/navpull and drops it on the PC clipboard for a
// galaxy-map paste. Fully per-pilot: identity comes from the signed Access JWT, so
// a commander can only push to their own clipboard.
//
// POST /blades/api/navpush { system } -> { ok, cmdr, system }
//
// Storage: BUILDS KV, key "nav:{cmdrLower}" -> { system, ts, by }. Short TTL so a
// stale target clears itself. Access-gated at the network layer (enlisted only).
const TTL_S = 600;
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
async function resolveCmdr(env, email) {
  try { const v = await env.BUILDS.get("cmdrlink:" + email); if (v) { const o = JSON.parse(v); if (o && o.cmdr) return String(o.cmdr); } } catch (e) {}
  return "";
}
// ED system names: letters, digits, spaces and - + . ' * / ( ) — kept tight but permissive.
function cleanSystem(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (!/^[\w .,'\-+*/()]{1,60}$/.test(s)) return "";
  return s.slice(0, 60);
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  if (!cmdr) return json({ ok: false, error: "no CMDR bound to this account" }, 409);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const system = cleanSystem(body.system);
  if (!system) return json({ ok: false, error: "system required" }, 400);
  const rec = { system, ts: Date.now(), by: cmdr };
  try { await env.BUILDS.put("nav:" + cmdr.toLowerCase(), JSON.stringify(rec), { expirationTtl: TTL_S }); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, cmdr, system });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades nav push. POST { system } (Access-gated) -> your PC clipboard via the plugin." });
}
