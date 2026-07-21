// Cloudflare Pages Function — namespace restore from a backup blob (recovery).
// POST /blades/api/import  { mode:"merge"|"replace", confirm?, builds, claims, admins, other }
//   mode "merge"   (default): write only the keys present in the blob; leaves other keys alone.
//   mode "replace" (requires confirm:true): delete EVERY existing key first, then write the blob.
//
// Admin-gated. Accepts the shape produced by /blades/api/export. This is the
// disaster-recovery path — the admin console previews counts + requires a typed
// confirmation before calling replace. Merge is safe to run any time.
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const SA = /^\d{1,20}$/;
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
const put = (env, k, v) => env.BUILDS.put(k, typeof v === "string" ? v : JSON.stringify(v));

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) { return json({ ok: false, error: "invalid JSON" }, 400); }

  const builds = (body.builds && typeof body.builds === "object") ? body.builds : {};
  const claims = (body.claims && typeof body.claims === "object") ? body.claims : {};
  const admins = Array.isArray(body.admins) ? body.admins.map(e => String(e).toLowerCase().trim()).filter(Boolean) : null;
  const other = (body.other && typeof body.other === "object") ? body.other : {};
  const mode = body.mode === "replace" ? "replace" : "merge";

  if (!Object.keys(builds).length && !Object.keys(claims).length && admins === null && !Object.keys(other).length) {
    return json({ ok: false, error: "empty backup — nothing to import" }, 400);
  }
  if (mode === "replace" && body.confirm !== true) {
    return json({ ok: false, error: "replace mode requires confirm:true" }, 400);
  }

  const out = { mode, builds: 0, claims: 0, admins: 0, other: 0, deleted: 0 };

  if (mode === "replace") {
    let cursor;
    do {
      const l = await env.BUILDS.list({ cursor });
      for (const k of l.keys) { await env.BUILDS.delete(k.name); out.deleted++; }
      cursor = l.list_complete ? null : l.cursor;
    } while (cursor);
  }

  for (const [id, rec] of Object.entries(builds)) { if (GUID.test(id)) { await put(env, id, rec); out.builds++; } }
  for (const [key, rec] of Object.entries(claims)) {
    const k = key.startsWith("claim:") ? key : ("claim:" + key);
    if (SA.test(k.slice(6))) { await put(env, k, rec); out.claims++; }
  }
  if (admins) {
    const list = admins.includes(OWNER) ? admins : admins.concat(OWNER); // never import a lock-out
    await put(env, "admin:emails", list); out.admins = list.length;
  }
  for (const [key, rec] of Object.entries(other)) {
    if (GUID.test(key) || key.startsWith("claim:") || key === "admin:emails") continue; // don't smuggle typed keys through other{}
    await put(env, key, rec); out.other++;
  }

  return json({ ok: true, ...out });
}
