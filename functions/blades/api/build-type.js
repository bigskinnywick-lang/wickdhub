// Cloudflare Pages Function — per-build station-type override.
//
// The plugin can only tell Raven a generic "consus" construction type, so the board
// can't show the real facility type (e.g. "Large Industrial Outpost — Gia pattern").
// This lets an admin set the true type per build; the board displays it over the
// generic label. (Layer 2 — self-learning from the commodity manifest so future builds
// auto-resolve — builds on this once the plugin stashes the original manifest.)
//
// GET    /blades/api/build-type                      (any Access user) -> { ok, overrides:{buildId:type} }
// PUT    /blades/api/build-type { buildId, type }    (admin) -> set
// DELETE /blades/api/build-type { buildId }          (admin) -> clear
//
// Storage: KV "btype:{buildId}" = { type, by, ts }.
const OWNER = "bigskinnywick@gmail.com";
const TYPE_MAX = 60;
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
async function adminList(env) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(x => String(x).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER);
  return admins;
}
async function isAdmin(request, env) { const e = callerEmail(request); return !!e && (await adminList(env)).includes(e); }
const cleanId = (v) => { const s = String(v || "").trim(); return /^[A-Za-z0-9._:-]{4,80}$/.test(s) ? s : ""; };
function cleanType(v) {
  const s = String(v || "").replace(/\s+/g, " ").trim();
  if (!s) return "";
  if (!/^[\w ,.'()\-\/&–—]{1,60}$/.test(s)) return "";
  return s.slice(0, TYPE_MAX);
}

const BASE_TYPE = { coriolis:"Coriolis Starport", orbis:"Orbis Starport", ocellus:"Ocellus Starport", asteroidbase:"Asteroid Starport", bernal:"Ocellus Starport", outpost:"Outpost", crateroutpost:"Surface Outpost", craterport:"Planetary Port", onfootsettlement:"Settlement", installation:"Installation", planetaryport:"Planetary Port", planetaryoutpost:"Surface Outpost" };
const ECON = { industrial:"Industrial", hightech:"High Tech", agri:"Agriculture", agriculture:"Agriculture", extraction:"Extraction", refinery:"Refinery", military:"Military", tourism:"Tourism", tourist:"Tourism", service:"Service", contraband:"Service", colony:"", terraforming:"Terraforming" };
function econName(raw){ let s=String(raw||"").toLowerCase().replace(/^\$?economy_/,"").replace(/;$/,""); return ECON[s]!==undefined?ECON[s]:(s?s.charAt(0).toUpperCase()+s.slice(1):""); }
function baseName(st){ const s=String(st||"").toLowerCase(); return BASE_TYPE[s]||String(st||""); }
function stationLabel(st,eco){ const b=baseName(st); const e=econName(eco); if(!b) return ""; if(!e) return b; return /Starport|Port/.test(b)?(b+" · "+e):(e+" "+b); }

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound", overrides: {} }, 500);
  const overrides = {};
  try {
    const list = await env.BUILDS.list({ prefix: "btype:" });
    for (const k of (list.keys || [])) {
      const rec = await readJson(env, k.name);
      if (rec && rec.type) overrides[k.name.slice("btype:".length)] = rec.type;
    }
  } catch (e) {}
  const stationMeta = {};
  try {
    const list2 = await env.BUILDS.list({ prefix: "stationmeta:" });
    for (const k of (list2.keys || [])) {
      const rec = await readJson(env, k.name);
      if (rec && rec.stationType) {
        const mid = k.name.slice("stationmeta:".length);
        stationMeta[mid] = { type: stationLabel(rec.stationType, rec.economy), economy: econName(rec.economy), base: baseName(rec.stationType), raw: rec.stationType };
      }
    }
  } catch (e) {}
  return json({ ok: true, overrides, stationMeta });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const buildId = cleanId(body.buildId);
  if (!buildId) return json({ ok: false, error: "valid buildId required" }, 400);
  const type = cleanType(body.type);
  if (!type) return json({ ok: false, error: "valid type required" }, 400);
  try { await env.BUILDS.put("btype:" + buildId, JSON.stringify({ type, by: callerEmail(request), ts: Date.now() })); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, buildId, type });
}

export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const buildId = cleanId(body.buildId);
  if (!buildId) return json({ ok: false, error: "valid buildId required" }, 400);
  try { await env.BUILDS.delete("btype:" + buildId); } catch (e) { return json({ ok: false, error: "delete failed" }, 500); }
  return json({ ok: true, buildId });
}
