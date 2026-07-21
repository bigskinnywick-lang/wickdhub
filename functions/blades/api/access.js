// Cloudflare Pages Function — Squad Access editor.
// Reads/edits the "Allow Blades" Cloudflare Access policy's allowed-email list via
// the Cloudflare API, so admins can grant/revoke SITE access (OTP login) for recruits
// without opening the Cloudflare dashboard. This is the ONLY layer that controls who
// can reach /blades at all (our KV/app code runs only after Access lets a request
// through), so the grant must happen on the Access policy itself.
//
// GET    /blades/api/access                 -> { ok, configured, emails:[...], other:[...], appId, policyId, policyName }
// PUT    /blades/api/access  { email }       -> add email to the policy include list
// DELETE /blades/api/access  { email }        -> remove email (owner + admins are protected)
//
// Admin-gated. Requires Pages secret CF_API_TOKEN (Access: Apps and Policies -> Edit).
// Every handler is wrapped so a failure ALWAYS returns JSON with the real cause,
// never a platform crash page.
const OWNER = "bigskinnywick@gmail.com";
const DEFAULT_ACCT = "d8ad5e450a31c4fdeb32f635f2041e8f";
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const CF = "https://api.cloudflare.com/client/v4";
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});

// --- identity + admin gate (JWT assertion; header not reliable in Pages behind Access) ---
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
}
async function adminList(env) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(x => String(x).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER);
  return admins;
}
async function isAdmin(request, env) { const e = callerEmail(request); return !!e && (await adminList(env)).includes(e); }

// --- Cloudflare API helper: reads text, surfaces the real error (status + code + body). ---
async function cf(env, path, opt) {
  let r;
  try { r = await fetch(CF + path, { ...opt, headers: { "Authorization": "Bearer " + env.CF_API_TOKEN, "content-type": "application/json", ...(opt && opt.headers) } }); }
  catch (e) { throw new Error("subrequest failed: " + (e && e.message || e)); }
  const text = await r.text();
  let d = null; try { d = JSON.parse(text); } catch (e) {}
  if (!d) throw new Error("CF " + r.status + " non-JSON: " + text.slice(0, 160));
  if (d.success !== true) {
    const e0 = d.errors && d.errors[0];
    throw new Error(e0 ? (e0.message + (e0.code ? " (code " + e0.code + ")" : "")) : ("CF API HTTP " + r.status));
  }
  return d.result;
}
let ID_CACHE = null; // per-isolate cache of resolved {acct,appId,policyId,policyName}
async function resolveIds(env) {
  if (ID_CACHE) return ID_CACHE;
  const acct = env.CF_ACCOUNT_ID || DEFAULT_ACCT;
  const appName = env.ACCESS_APP_NAME || "Onyx Blades Board";
  const policyName = env.ACCESS_POLICY_NAME || "Allow Blades";
  let appId = env.ACCESS_APP_ID, policyId = env.ACCESS_POLICY_ID, foundPolicyName = policyName;
  if (!appId) {
    const apps = await cf(env, `/accounts/${acct}/access/apps`);
    const app = apps.find(a => a.name === appName) || apps.find(a => (a.domain || "").includes("/blades"));
    if (!app) throw new Error(`Access app "${appName}" not found`);
    appId = app.id;
  }
  if (!policyId) {
    const pols = await cf(env, `/accounts/${acct}/access/apps/${appId}/policies`);
    const pol = pols.find(p => p.name === policyName) || pols[0];
    if (!pol) throw new Error(`Access policy "${policyName}" not found`);
    policyId = pol.id; foundPolicyName = pol.name;
  }
  ID_CACHE = { acct, appId, policyId, policyName: foundPolicyName };
  return ID_CACHE;
}
async function getPolicy(env, ids) {
  return cf(env, `/accounts/${ids.acct}/access/apps/${ids.appId}/policies/${ids.policyId}`);
}
// Write the include list back with a MINIMAL documented body (name/decision/include/
// exclude/require). Tries the app-scoped policy endpoint, then falls back to the
// account-level reusable-policy endpoint if the first path 404s / rejects.
async function writeInclude(env, ids, policy, include) {
  const body = {
    name: policy.name,
    decision: policy.decision || "allow",
    include,
    exclude: policy.exclude || [],
    require: policy.require || [],
  };
  if (policy.precedence != null) body.precedence = policy.precedence;
  const payload = JSON.stringify(body);
  try {
    return await cf(env, `/accounts/${ids.acct}/access/apps/${ids.appId}/policies/${ids.policyId}`, { method: "PUT", body: payload });
  } catch (e1) {
    try {
      return await cf(env, `/accounts/${ids.acct}/access/policies/${ids.policyId}`, { method: "PUT", body: payload });
    } catch (e2) {
      throw new Error("app-scoped: " + (e1 && e1.message || e1) + " | reusable: " + (e2 && e2.message || e2));
    }
  }
}
// include rule shape for an allowed email: { email: { email: "x@y.com" } }
const emailsFrom = (include) => (include || []).filter(r => r && r.email && r.email.email).map(r => String(r.email.email).toLowerCase());
const otherFrom = (include) => (include || []).filter(r => !(r && r.email && r.email.email)).map(r => Object.keys(r || {})[0] || "rule");

function notConfigured(extra) { return json({ ok: true, configured: false, emails: [], other: [], note: "CF_API_TOKEN not set — see setup steps", ...extra }); }

async function guard(request, env) {
  if (!env || !env.BUILDS) return { stop: json({ ok: false, error: "KV not bound" }, 500) };
  if (!(await isAdmin(request, env))) return { stop: json({ ok: false, error: "forbidden" }, 403) };
  return {};
}

export async function onRequestGet({ request, env }) {
  try {
    const g = await guard(request, env); if (g.stop) return g.stop;
    if (!env.CF_API_TOKEN) return notConfigured();
    const ids = await resolveIds(env);
    const policy = await getPolicy(env, ids);
    return json({ ok: true, configured: true, emails: emailsFrom(policy.include), other: otherFrom(policy.include), appId: ids.appId, policyId: ids.policyId, policyName: ids.policyName });
  } catch (e) { return json({ ok: false, configured: true, error: String(e && e.message || e), step: "get" }, 502); }
}

export async function onRequestPut({ request, env }) {
  try {
    const g = await guard(request, env); if (g.stop) return g.stop;
    if (!env.CF_API_TOKEN) return json({ ok: false, error: "CF_API_TOKEN not configured" }, 400);
    let body = {}; try { body = await request.json(); } catch (e) {}
    const email = String(body.email || "").toLowerCase().trim();
    if (!EMAIL.test(email)) return json({ ok: false, error: "invalid email" }, 400);
    const ids = await resolveIds(env);
    const policy = await getPolicy(env, ids);
    const current = emailsFrom(policy.include);
    if (current.includes(email)) return json({ ok: true, added: false, already: true, emails: current, other: otherFrom(policy.include) });
    const include = [...(policy.include || []), { email: { email } }];
    const updated = await writeInclude(env, ids, policy, include);
    const inc = (updated && updated.include) || include;
    return json({ ok: true, added: true, emails: emailsFrom(inc), other: otherFrom(inc) });
  } catch (e) { return json({ ok: false, error: String(e && e.message || e), step: "put" }, 502); }
}

export async function onRequestDelete({ request, env }) {
  try {
    const g = await guard(request, env); if (g.stop) return g.stop;
    if (!env.CF_API_TOKEN) return json({ ok: false, error: "CF_API_TOKEN not configured" }, 400);
    let body = {}; try { body = await request.json(); } catch (e) {}
    const email = String(body.email || "").toLowerCase().trim();
    if (!EMAIL.test(email)) return json({ ok: false, error: "invalid email" }, 400);
    if (email === OWNER) return json({ ok: false, error: "owner access cannot be revoked" }, 400);
    const admins = await adminList(env);
    if (admins.includes(email)) return json({ ok: false, error: "this email is an admin — remove them from the admin roster first" }, 400);
    const ids = await resolveIds(env);
    const policy = await getPolicy(env, ids);
    const current = emailsFrom(policy.include);
    if (!current.includes(email)) return json({ ok: true, removed: false, emails: current, other: otherFrom(policy.include) });
    if (current.length <= 1) return json({ ok: false, error: "refusing to remove the last allowed email" }, 400);
    const include = (policy.include || []).filter(r => !(r && r.email && r.email.email && String(r.email.email).toLowerCase() === email));
    const updated = await writeInclude(env, ids, policy, include);
    const inc = (updated && updated.include) || include;
    return json({ ok: true, removed: true, emails: emailsFrom(inc), other: otherFrom(inc) });
  } catch (e) { return json({ ok: false, error: String(e && e.message || e), step: "delete" }, 502); }
}
