// Cloudflare Pages Function — the signed-in pilot's beta-wing TIER (retail / beta / research).
//
// The test-pilot ROLE (plugin:roles) = ELIGIBILITY (admin-granted). This TIER flag = the
// pilot's OWN choice of which track they're on. It's the single server-side source of
// truth, so every window on every device shows the same armed/disarmed state.
//
// GET  /blades/api/testpilot            -> { ok, cmdr, eligible, admin, tier, tiers }
// POST /blades/api/testpilot { tier }    -> set the CALLER'S OWN tier (validated vs clearance)
//
// Access-gated (any member). A pilot can only ever set their own tier — identity comes
// from the signed Access JWT, not the body. Storage: BUILDS KV "plugin:tier" -> { cmdrLower: tier }
// (non-GUID key -> rides export other{}). "retail" is the default and clears the entry.
const OWNER = "bigskinnywick@gmail.com";
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
async function resolveCmdr(env, email) { const o = await readJson(env, "cmdrlink:" + email); return (o && o.cmdr) ? String(o.cmdr) : ""; }
async function hasRole(env, cmdrLower, role) {
  const m = await readJson(env, "plugin:roles");
  const r = m && m[cmdrLower];
  return Array.isArray(r) && r.map(x => String(x).toLowerCase()).includes(String(role).toLowerCase());
}
async function isAdmin(env, email) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(x => String(x).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER); // anti-lockout
  return admins.includes(email);
}
// Which tracks a pilot is cleared for. Retail = everyone; beta = test pilots + admins;
// research = admins only (the sealed alpha tier — pages don't exist yet, but the clearance does).
function tiersFor(eligible, admin) { const t = ["retail"]; if (eligible || admin) t.push("beta"); if (admin) t.push("research"); return t; }

async function state(env, email) {
  const admin = await isAdmin(env, email);
  const cmdr = await resolveCmdr(env, email);
  const cmdrLower = cmdr.toLowerCase();
  const eligible = cmdr ? await hasRole(env, cmdrLower, "testpilot") : false;
  const tiers = tiersFor(eligible, admin);
  let tier = "retail";
  if (cmdr) { const m = await readJson(env, "plugin:tier"); const t = m && m[cmdrLower]; if (t && tiers.includes(String(t))) tier = String(t); }
  return { cmdr, cmdrLower, admin, eligible, tiers, tier };
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const s = await state(env, email);
  return json({ ok: true, cmdr: s.cmdr, eligible: s.eligible, admin: s.admin, tier: s.tier, tiers: s.tiers });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const s = await state(env, email);
  if (!s.cmdr) return json({ ok: false, error: "no cmdr bound" }, 400);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const want = String(body.tier || "").toLowerCase().trim();
  if (!s.tiers.includes(want)) return json({ ok: false, error: "tier not permitted" }, 403);
  const m = (await readJson(env, "plugin:tier")) || {};
  if (want === "retail") delete m[s.cmdrLower]; else m[s.cmdrLower] = want;
  try { await env.BUILDS.put("plugin:tier", JSON.stringify(m)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, cmdr: s.cmdr, eligible: s.eligible, admin: s.admin, tier: want, tiers: s.tiers });
}
