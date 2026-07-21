// Cloudflare Pages Function — custom SQUAD NET ticker slots.
// Four admin-editable slots that get interleaved into the dashboard ticker:
//   galnet (GalNet AI summary), cg (Community Goals), free1 + free2 (squad
//   announcements, birthdays, anything). Adam pastes AI summaries into the
//   dedicated slots; empty text = slot hidden from the ticker.
//
// GET  /blades/api/ticker           -> { fields:[{key,label,text,updatedTs,updatedBy}] }  (any Access user — the dashboard reads it)
// PUT  /blades/api/ticker { key, label?, text }  -> update one slot (admin-gated)
//
// Storage: BUILDS KV, key "ticker:custom" -> { fields:[...], updatedTs, updatedBy }.
// Non-GUID key, so it's ignored by the build list and rides along in export "other{}"
// (backed up + restorable).
const OWNER = "bigskinnywick@gmail.com";
const SLOTS = [
  { key: "galnet", label: "GALNET", text: "10 Jun 3312 — Radicoida Unica ruled 'cultivated, not created': researchers say the Guardians farmed the rare bloom rather than engineering it, with archive data hinting they used it to sharpen their warriors. Also on the wire — Frontline Solutions expands rapid-response anti-piracy ops as an unidentified criminal fleet bearing strange insignia is sighted across several systems." },
  { key: "cg", label: "COMMUNITY GOALS", text: "Colonia Council Anniversary Celebrations — haul commodities & rare goods to Peters Base (Facece) for Colonia's 10th. Tier 2/5, ~21% in with 10k+ commanders, ~3 days left. Credit + cosmetic payouts scale with your contribution tier." },
  { key: "free1", label: "SQUAD" },
  { key: "free2", label: "NOTICE" },
];
const KEYS = new Set(SLOTS.map(s => s.key));
const LABEL_MAX = 32, TEXT_MAX = 500;
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
// admin gate (JWT assertion; header not reliable in Pages behind Access)
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

async function load(env) {
  let saved = {};
  try { const v = await env.BUILDS.get("ticker:custom"); if (v) { const o = JSON.parse(v); if (o && Array.isArray(o.fields)) saved = Object.fromEntries(o.fields.map(f => [f.key, f])); } } catch (e) {}
  return SLOTS.map(s => {
    const f = saved[s.key];
    if (f) { // explicitly set by an admin (including a deliberate clear) — respect it, don't re-seed
      const label = (f.label != null && String(f.label).trim()) ? String(f.label) : s.label;
      return { key: s.key, label, text: f.text || "", expiresTs: f.expiresTs || null, updatedTs: f.updatedTs || null, updatedBy: f.updatedBy || "" };
    }
    return { key: s.key, label: s.label, text: s.text || "", expiresTs: null, updatedTs: null, updatedBy: "" }; // not yet set → seed default
  });
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound", fields: [] }, 500);
  return json({ ok: true, fields: await load(env) });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const key = String(body.key || "").trim();
  if (!KEYS.has(key)) return json({ ok: false, error: "invalid slot key" }, 400);
  const fields = await load(env);
  const slot = fields.find(f => f.key === key);
  if (typeof body.text === "string") slot.text = body.text.slice(0, TEXT_MAX);
  if (typeof body.label === "string" && body.label.trim()) slot.label = body.label.trim().slice(0, LABEL_MAX);
  if ("expiresTs" in body) { const t = Number(body.expiresTs); slot.expiresTs = (body.expiresTs == null || !(t > 0)) ? null : t; }
  slot.updatedTs = Date.now();
  slot.updatedBy = callerEmail(request);
  await env.BUILDS.put("ticker:custom", JSON.stringify({ fields, updatedTs: Date.now(), updatedBy: callerEmail(request) }));
  return json({ ok: true, fields });
}
