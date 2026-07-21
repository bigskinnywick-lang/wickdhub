// Cloudflare Pages Function — full KV namespace export (backup).
// GET /blades/api/export  -> one JSON blob of the entire onyx_builds namespace.
//   { version, exportedTs, exportedBy, buildCount, claimCount, builds:{id:rec},
//     claims:{"claim:sa":rec}, admins:[...], other:{key:rec} }
//
// Admin-gated. Walks the whole namespace with cursor pagination (correct beyond the
// current ~kilobyte scale). This is the backup source: the admin console's
// "Download backup" button saves this blob to a file, which Adam drops into the repo
// backups/ folder and pushes via GitHub Desktop — git becomes the versioned, diffable,
// offsite backup. /blades/api/import is the recovery counterpart.
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const OWNER = "bigskinnywick@gmail.com";
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const callerEmail = (request) => (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
async function adminList(env) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(e => String(e).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER);
  return admins;
}
async function isAdmin(request, env) { const e = callerEmail(request); return !!e && (await adminList(env)).includes(e); }

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);

  const builds = {}, claims = {}, other = {};
  let admins = [];
  let cursor;
  do {
    const l = await env.BUILDS.list({ cursor });
    for (const k of l.keys) {
      let val = null;
      try { const v = await env.BUILDS.get(k.name); if (v != null) { try { val = JSON.parse(v); } catch (e) { val = v; } } } catch (e) {}
      if (k.name === "admin:emails") { admins = Array.isArray(val) ? val : []; }
      else if (k.name.startsWith("claim:")) { claims[k.name] = val; }
      else if (GUID.test(k.name)) { builds[k.name] = val; }
      else { other[k.name] = val; }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);

  return json({
    version: 1,
    exportedTs: Date.now(),
    exportedBy: callerEmail(request),
    buildCount: Object.keys(builds).length,
    claimCount: Object.keys(claims).length,
    builds, claims, admins, other,
  });
}
