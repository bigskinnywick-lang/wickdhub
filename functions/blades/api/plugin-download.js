// Cloudflare Pages Function — role-aware Blades Registrar download.
//
// Test pilots get the BETA build; everyone else gets STABLE — but the file always
// downloads as "BladesRegistrar.zip" (same name, different payload), so installing it
// just swaps load.py in place. EDMC then shows whatever version is baked into that
// build, so a beta build (e.g. "b2.0") reads as a beta flavour. Flip a pilot's
// testpilot role in /blades/admin to swap them between beta and retail on next download.
//
// GET /blades/api/plugin-download (Access-gated) -> the .zip bytes, filename BladesRegistrar.zip
const URLS = {
  stable: "https://wickdhub.com/blades/BladesRegistrar.zip",
  beta: "https://wickdhub.com/blades/BladesRegistrar-beta.zip",
};
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
async function hasRole(env, cmdrLower, role) {
  const m = await readJson(env, "plugin:roles");
  const r = m && m[cmdrLower];
  return Array.isArray(r) && r.map(x => String(x).toLowerCase()).includes(String(role).toLowerCase());
}
async function fetchZip(env, url) {
  let resp = null;
  try { if (env.ASSETS && env.ASSETS.fetch) resp = await env.ASSETS.fetch(new Request(url)); } catch (e) {}
  if (!resp || !resp.ok) { try { resp = await fetch(url, { cf: { cacheTtl: 0 } }); } catch (e) {} }
  return (resp && resp.ok) ? resp : null;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return err("KV not bound", 500);
  const email = callerEmail(request);
  const cmdr = email ? await resolveCmdr(env, email) : "";
  const testpilot = cmdr ? await hasRole(env, cmdr.toLowerCase(), "testpilot") : false;
  const channel = testpilot ? "beta" : "stable";
  let resp = await fetchZip(env, URLS[channel]);
  if (!resp && channel === "beta") resp = await fetchZip(env, URLS.stable); // no beta zip yet -> fall back to stable
  if (!resp) return err("plugin unavailable", 502);
  const buf = await resp.arrayBuffer();
  return new Response(buf, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="BladesRegistrar.zip"',
      "cache-control": "no-store", // per-pilot payload — never shared-cache
      "x-blades-channel": channel,
    },
  });
}
