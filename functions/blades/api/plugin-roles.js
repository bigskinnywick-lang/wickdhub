// Cloudflare Pages Function — admin management of member roles.
//
// First brick of a wider roles system. KV "plugin:roles" is a map { cmdrLower:
// ["testpilot","officer",...] }. Today only "testpilot" is load-bearing (it flips a
// pilot to the beta release channel in navpull / plugin-status); the others are stored
// for future use. The existing email-based admin gate stays separate for now.
//
// GET  /blades/api/plugin-roles  (admin) -> { ok, roles, pilots:[{cmdr,running,pending,ts}] }
// POST /blades/api/plugin-roles  (admin) { cmdr, roles:[...] } -> { ok, roles }  (empty roles clears the entry)
const OWNER = "bigskinnywick@gmail.com";
const ALLOWED = ["member", "testpilot", "officer", "admin"];
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
function cleanCmdr(v) { const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim(); return /^[\w .'\-]{1,40}$/.test(s) ? s.slice(0, 40) : ""; }
function cleanRoles(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) { const r = String(x || "").toLowerCase().trim(); if (ALLOWED.includes(r) && !out.includes(r)) out.push(r); }
  return out;
}
async function listPilots(env) {
  const out = [];
  try {
    const list = await env.BUILDS.list({ prefix: "cmdrver:" });
    for (const k of (list.keys || [])) {
      const rec = await readJson(env, k.name);
      if (rec) out.push({ cmdr: k.name.slice("cmdrver:".length), running: rec.running || "", pending: rec.pending || "", ts: rec.ts || 0 });
    }
  } catch (e) {}
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  return json({ ok: true, roles: (await readJson(env, "plugin:roles")) || {}, allowed: ALLOWED, pilots: await listPilots(env) });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const cmdr = cleanCmdr(body.cmdr);
  if (!cmdr) return json({ ok: false, error: "valid cmdr required" }, 400);
  const roles = cleanRoles(body.roles);
  const map = (await readJson(env, "plugin:roles")) || {};
  const key = cmdr.toLowerCase();
  if (roles.length) map[key] = roles; else delete map[key];
  try { await env.BUILDS.put("plugin:roles", JSON.stringify(map)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, roles: map });
}
