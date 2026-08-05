// Cloudflare Pages Function — test-pilot-only BladeRelay download.
//
// BladeRelay is BETA / test-pilot-only right now: there is NO retail build. Only a pilot
// ARMED on the beta test-track (KV "plugin:tier" != "retail" — the SAME switch the Blades
// Registrar uses) may pull it; everyone else is refused. Serves the exe as BladeRelay.exe.
// Mirrors plugin-download.js, minus the retail fallback (there is nothing to fall back to).
//
// GET /blades/api/helper-download   (Cloudflare Access-gated) -> BladeRelay.exe bytes | 403
const BETA_URL = "https://wickdhub.com/blades/BladeRelay-beta.exe";
const err = (msg, s) => new Response(msg, { status: s || 500, headers: { "cache-control": "no-store" } });
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
async function fetchAsset(env, url) {
  let resp = null;
  try { if (env.ASSETS && env.ASSETS.fetch) resp = await env.ASSETS.fetch(new Request(url)); } catch (e) {}
  if (!resp || !resp.ok) { try { resp = await fetch(url, { cf: { cacheTtl: 0 } }); } catch (e) {} }
  return (resp && resp.ok) ? resp : null;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return err("KV not bound", 500);
  const email = callerEmail(request);
  const cmdr = email ? await resolveCmdr(env, email) : "";
  // Channel follows the pilot's OWN test-track switch (KV "plugin:tier"), exactly like the
  // Registrar. No arm = no BladeRelay (it's beta-only; there is no retail build yet).
  const tierMap = cmdr ? await readJson(env, "plugin:tier") : null;
  const tier = (tierMap && tierMap[cmdr.toLowerCase()]) ? String(tierMap[cmdr.toLowerCase()]).toLowerCase() : "retail";
  if (tier === "retail") return err("BladeRelay is test-pilot only right now — arm your beta test-track to install it.", 403);
  const resp = await fetchAsset(env, BETA_URL);
  if (!resp) return err("BladeRelay build unavailable", 502);
  const buf = await resp.arrayBuffer();
  return new Response(buf, {
    headers: {
      "content-type": "application/octet-stream",
      "content-disposition": 'attachment; filename="BladeRelay.exe"',
      "cache-control": "no-store",     // per-pilot gate — never shared-cache
      "x-blades-channel": "beta",
    },
  });
}
