// Cloudflare Pages Function — admin roster + self identity ("whoami").
// GET    /blades/api/admins  -> { me, isAdmin, admins? }   (admins list only returned to admins)
// PUT    /blades/api/admins  { email }  -> add an admin       (admin-gated)
// DELETE /blades/api/admins  { email }  -> remove an admin     (admin-gated; owner is non-removable)
//
// Admin status is a second, finer gate ON TOP of the /blades Cloudflare Access app.
// An Access-authenticated squadmate who is not an admin is simply not an admin here.
//
// Storage: BUILDS KV, single key "admin:emails" -> JSON array of lowercased emails.
// The OWNER email is ALWAYS treated as an admin even if the key is missing or was
// edited to exclude them — this is the anti-lockout guarantee. That also means the
// key does not need hand-seeding: the owner is admin from day one, and adding the
// first designated admin via PUT creates the key.
const OWNER = "bigskinnywick@gmail.com";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export function callerEmail(request) {
  return (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
}
export async function adminList(env) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(e => String(e).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER); // anti-lockout: owner is always an admin
  return admins;
}
export async function isAdmin(request, env) {
  const e = callerEmail(request);
  return !!e && (await adminList(env)).includes(e);
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  const admins = await adminList(env);
  const admin = !!me && admins.includes(me);
  return admin ? json({ me, isAdmin: true, admins }) : json({ me, isAdmin: false });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").toLowerCase().trim();
  if (!EMAIL.test(email)) return json({ ok: false, error: "invalid email" }, 400);
  const admins = await adminList(env);
  if (!admins.includes(email)) admins.push(email);
  await env.BUILDS.put("admin:emails", JSON.stringify(admins));
  return json({ ok: true, admins });
}

export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").toLowerCase().trim();
  if (email === OWNER) return json({ ok: false, error: "owner cannot be removed" }, 400);
  let admins = (await adminList(env)).filter(e => e !== email);
  if (!admins.includes(OWNER)) admins.push(OWNER);
  await env.BUILDS.put("admin:emails", JSON.stringify(admins));
  return json({ ok: true, admins });
}
