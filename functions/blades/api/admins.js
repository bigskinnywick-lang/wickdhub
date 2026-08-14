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

function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
// Identity behind Cloudflare Access. Pages Functions do not reliably receive the
// convenience header, but always get the signed JWT assertion (Access already
// validated it to let the request reach us) — decode its `email` claim.
export function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
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
// ★ OWNER IS HARDCODED AND NEVER KV-DRIVEN. adminList() reads `admin:emails` from KV; if a
// KV-driven owner check were used instead, one corrupted or hostile write to that key would
// strip Adam of his own ownership — the single thing that must never be losable. Compare the
// signed JWT email against the constant and nothing else. No env, no await, no I/O.
//
// THE BOUNDARY THIS DRAWS (Adam, 2026-08-13): an admin may OPERATE the machine; only the
// owner may change WHO CONTROLS the machine, or do anything no backup can undo. Before this,
// every sensitive route gated on isAdmin and OWNER was only an anti-lockout constant — which
// meant any admin could add another admin, restore the namespace, edit who may log in, and
// cut a release onto every pilot's PC. The only real limit was that the owner couldn't be
// removed. Fine while Adam was the only admin; the second admin is when it bit.
export function isOwner(request) {
  return callerEmail(request) === OWNER;
}
// Admiral roster — a leadership tier that unlocks the Admiral's Desk ONLY (welcome-message
// editor), not the full admin console. Stored in KV "admiral:emails" (JSON array, lowercased).
// Every admin is implicitly an admiral (admin is the superset); the reverse is not true.
export async function admiralList(env) {
  let a = [];
  try { const v = await env.BUILDS.get("admiral:emails"); if (v) { const arr = JSON.parse(v); if (Array.isArray(arr)) a = arr.map(e => String(e).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  return a;
}
export async function isAdmiral(request, env) {
  const e = callerEmail(request);
  if (!e) return false;
  if ((await adminList(env)).includes(e)) return true;
  return (await admiralList(env)).includes(e);
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  const admins = await adminList(env);
  const admin = !!me && admins.includes(me);
  const admirals = await admiralList(env);
  const isAdmiralTier = admin || (!!me && admirals.includes(me));
  // isOwner rides on whoami so the console can hide owner-only panels rather than letting an
  // admin click into a 403. Advisory ONLY — the server gate below is the real boundary and
  // must never be relaxed on the strength of the UI honouring this flag.
  const owner = isOwner(request);
  return admin
    ? json({ me, isAdmin: true, isOwner: owner, isAdmiral: true, admins, admirals })
    : json({ me, isAdmin: false, isOwner: owner, isAdmiral: isAdmiralTier });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  // OWNER ONLY — "who controls the machine". An admin who can add an admin can add a
  // confederate, and that is the whole escalation path in one line.
  if (!isOwner(request)) return json({ ok: false, error: "forbidden — owner only" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").toLowerCase().trim();
  if (!EMAIL.test(email)) return json({ ok: false, error: "invalid email" }, 400);
  if (String(body.role || "") === "admiral") {
    const admirals = await admiralList(env);
    if (!admirals.includes(email)) admirals.push(email);
    await env.BUILDS.put("admiral:emails", JSON.stringify(admirals));
    return json({ ok: true, admirals });
  }
  const admins = await adminList(env);
  if (!admins.includes(email)) admins.push(email);
  await env.BUILDS.put("admin:emails", JSON.stringify(admins));
  return json({ ok: true, admins });
}

export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  // OWNER ONLY — removal is the same authority as appointment. An admin who can remove
  // admins can quietly shrink the roster to himself.
  if (!isOwner(request)) return json({ ok: false, error: "forbidden — owner only" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const email = String(body.email || "").toLowerCase().trim();
  if (String(body.role || "") === "admiral") {
    const admirals = (await admiralList(env)).filter(e => e !== email);
    await env.BUILDS.put("admiral:emails", JSON.stringify(admirals));
    return json({ ok: true, admirals });
  }
  if (email === OWNER) return json({ ok: false, error: "owner cannot be removed" }, 400);
  let admins = (await adminList(env)).filter(e => e !== email);
  if (!admins.includes(OWNER)) admins.push(OWNER);
  await env.BUILDS.put("admin:emails", JSON.stringify(admins));
  return json({ ok: true, admins });
}
