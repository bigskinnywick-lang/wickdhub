// Cloudflare Pages Function — home "welcome message" (a.k.a. Wicked Wisdom).
//
// The squadron leader edits the home page's welcome message from the Admiral's Desk;
// this is where it's stored and read. Kept generic ("welcome message") on purpose —
// today it's Wicked Wisdom, later the leader may reframe it.
//
// GET /blades/api/wisdom            -> { ok, text, author, role, updatedTs, updatedBy }  (any Access user)
// PUT /blades/api/wisdom { text, author?, role? }  -> save (leadership-gated)
//
// Storage: BUILDS KV, key "home:wisdom". Non-GUID key => ignored by the build list,
// rides along in export other{} (backed up + restorable). Same admin-gate pattern as
// ticker.js. NOTE: GET is under the Access-gated /blades/api, so the PUBLIC home cannot
// read it yet — surfacing leader edits onto the public front door is an activation-time
// decision (bypass this GET in Access, or mirror to a public key). Until then the public
// home keeps using its CONFIG default; members/leadership see live edits.
const OWNER = "bigskinnywick@gmail.com";
const TEXT_MAX = 1200, NAME_MAX = 60;
// Seed matches the current home CONFIG default so GET always returns something sane.
const SEED = {
  text: "You found us because you were looking for a crew that actually flies together. That's what the Blades are. We don't run spreadsheets and roll-call — the tools watch the work and we go build. Fly how you like, tell us what you're into, and lean on the wing when it's time to move something big. Welcome aboard, Commander.",
  author: "THE ADMIRAL",
  role: "Onyx Blades Squadron",
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
// Leadership gate = the admin roster + the Admiral roster + OWNER. The Admiral tier
// (KV "admiral:emails") can edit this welcome message without holding full admin powers.
async function leadershipList(env) {
  let a = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const arr = JSON.parse(v); if (Array.isArray(arr)) a = arr.map(x => String(x).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  try { const v = await env.BUILDS.get("admiral:emails"); if (v) { const arr = JSON.parse(v); if (Array.isArray(arr)) arr.forEach(x => { const e = String(x).toLowerCase().trim(); if (e && !a.includes(e)) a.push(e); }); } } catch (e) {}
  if (!a.includes(OWNER)) a.push(OWNER);
  return a;
}
async function isLeadership(request, env) { const e = callerEmail(request); return !!e && (await leadershipList(env)).includes(e); }

async function load(env) {
  try { const v = await env.BUILDS.get("home:wisdom"); if (v) { const o = JSON.parse(v); if (o && typeof o.text === "string") return o; } } catch (e) {}
  return { ...SEED, updatedTs: null, updatedBy: "" };
}

export async function onRequestGet({ env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound", ...SEED }, 500);
  const w = await load(env);
  return json({ ok: true, text: w.text, author: w.author || SEED.author, role: w.role || SEED.role, updatedTs: w.updatedTs || null, updatedBy: w.updatedBy || "" });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isLeadership(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const text = typeof body.text === "string" ? body.text.trim().slice(0, TEXT_MAX) : "";
  if (!text) return json({ ok: false, error: "text required" }, 400);
  const cur = await load(env);
  const rec = {
    text,
    author: (typeof body.author === "string" && body.author.trim()) ? body.author.trim().slice(0, NAME_MAX) : (cur.author || SEED.author),
    role: (typeof body.role === "string" && body.role.trim()) ? body.role.trim().slice(0, NAME_MAX) : (cur.role || SEED.role),
    updatedTs: Date.now(),
    updatedBy: callerEmail(request),
  };
  await env.BUILDS.put("home:wisdom", JSON.stringify(rec));
  return json({ ok: true, ...rec });
}
