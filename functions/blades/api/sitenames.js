// Cloudflare Pages Function — squad site-name overrides for the colonisation board.
//
// RavenColonial only names a build at CREATE time and won't rename an existing one, so
// two identical-looking construction sites (same body/type) can't be told apart. This is
// the squad's own display-only name layer: officers/admins set a name per build; the board
// shows it over RavenColonial's generic label. Never touches Raven or its progress.
//
// GET /blades/api/sitenames                    -> { ok, names: { "<buildId>": "Name" } }  (any enlisted)
// PUT /blades/api/sitenames { buildId, name }  -> set (empty name clears)  (officers + admins)
//
// Storage: BUILDS KV, "sitename:{buildId}" -> { name, by, ts }. A small SEED backfills the
// two known active sites so they appear immediately on deploy; a KV entry overrides the seed.
const OWNER = "bigskinnywick@gmail.com";
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const NAME_MAX = 60;

// Backfill: journal-confirmed facility names for the two active Col 285 BU-O b7-3 sites.
const SEED = {
  "01f3922f-235b-4f65-802b-11695424e921": "Pace Engineering Exchange",
  "e24d947f-a573-47ee-8e22-b62945db4ef0": "Mendy Chemical Productions",
};

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
// Officers + admins: the admin roster + the Admiral roster + OWNER (same model as wisdom.js).
async function leadershipList(env) {
  let a = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const arr = JSON.parse(v); if (Array.isArray(arr)) a = arr.map(x => String(x).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  try { const v = await env.BUILDS.get("admiral:emails"); if (v) { const arr = JSON.parse(v); if (Array.isArray(arr)) arr.forEach(x => { const e = String(x).toLowerCase().trim(); if (e && !a.includes(e)) a.push(e); }); } } catch (e) {}
  if (!a.includes(OWNER)) a.push(OWNER);
  return a;
}
async function isLeadership(request, env) { const e = callerEmail(request); return !!e && (await leadershipList(env)).includes(e); }

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound", names: {} }, 500);
  if (!callerEmail(request)) return json({ ok: false, error: "no identity", names: {} }, 403);
  const names = Object.assign({}, SEED);
  try {
    const listing = await env.BUILDS.list({ prefix: "sitename:" });
    for (const k of listing.keys) {
      const id = k.name.slice("sitename:".length);
      let rec = null;
      try { const v = await env.BUILDS.get(k.name); if (v) rec = JSON.parse(v); } catch (e) {}
      if (rec && typeof rec.name === "string" && rec.name.trim()) names[id] = rec.name.trim();
      else delete names[id]; // an explicit blank clears the seed too
    }
  } catch (e) {}
  return json({ ok: true, names });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isLeadership(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const buildId = String(body.buildId || "").toLowerCase().trim();
  if (!GUID.test(buildId)) return json({ ok: false, error: "invalid buildId" }, 400);
  const name = typeof body.name === "string" ? body.name.trim().slice(0, NAME_MAX) : "";
  const rec = { name, by: callerEmail(request), ts: Date.now() };
  try { await env.BUILDS.put("sitename:" + buildId, JSON.stringify(rec)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, buildId, name });
}
