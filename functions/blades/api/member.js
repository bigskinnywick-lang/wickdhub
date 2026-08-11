// Cloudflare Pages Function — member record + privacy preferences (Form OB-1, phase 1).
//
// GET   /blades/api/member   -> { ok, me, cmdr, member:{...} }   (auto-provisions on first read)
// PATCH /blades/api/member   { prefs?:{...}, discord?:"..." }    -> update OWN record only
//
// Access-gated at the network layer. Identity comes from the signed Access JWT, never the
// body, so a caller can only ever read or write their own record.
//
// ── STORAGE ────────────────────────────────────────────────────────────────────────────
//   member:{email}  -> { discord, enlisted_at, status, last_seen_at, prefs:{...}, rev }
//   rig:{email}     -> RESERVED. Flight-rig data lives in its OWN key, never inside the
//                      member blob, so the departure purge is a single unambiguous delete
//                      instead of a surgical edit that will one day miss a field.
//   cmdrlink:{email} -> { cmdr, ts }   ← PRE-EXISTING, and still the ONLY source of truth
//                      for the CMDR name. We join to it rather than copying, because two
//                      copies of an identity is two chances to disagree.
//
// ── THE DISTINCTION THAT MATTERS ───────────────────────────────────────────────────────
// DEFAULTS are policy, applied ONCE at provisioning and written explicitly to the record.
// RENDERING is strict: a preference is honoured only if it is exactly `true`. These are
// deliberately NOT the same function. If a pref is missing at render time that is a bug or
// a migration gap, and the safe answer is the private one — never the default. An empty
// prefs object must yield a member who appears as nothing but a number.
const OWNER = "bigskinnywick@gmail.com";

// Live preference keys. `list_rig` is ABSENT ON PURPOSE — Section III of the card ships as
// PREVIEW · NOT YET ACTIVE, and a disabled control that still posts a value is the standard
// version of that bug. When the rig feature goes live, add it here and bump the card's REV.
const PREF_KEYS = ["show_on_roster", "link_discord_public", "show_activity", "credit_contributions"];
const RIG_PREF = "list_rig";
const RIG_FEATURE_LIVE = false;

const STATUSES = ["ACTIVE", "MIA", "KIA", "DISCHARGED", "DISHONOURABLE", "EXPUNGED"];

const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
// Behind Access, Pages Functions get the signed JWT assertion reliably (the header not always).
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
}

export function memberKey(email) { return "member:" + String(email || "").toLowerCase().trim(); }
export function rigKey(email) { return "rig:" + String(email || "").toLowerCase().trim(); }

// POLICY defaults — written explicitly at provisioning. Never consulted at render time.
export function defaultPrefs() {
  return {
    show_on_roster: true,        // CMDR name on the squadron roster
    link_discord_public: false,  // handle shown beside the name — protects the RP persona
    show_activity: true,         // activity + usual flight hours
    credit_contributions: true,  // contributions credited by name on boards
  };
}

// RENDER-TIME gate. Strict identity check: absent, null, "false", 0 and undefined all mean NO.
export function visible(prefs, key) {
  return !!prefs && prefs[key] === true;
}

// Discord handles: permissive enough for modern usernames + legacy discriminators, bounded.
export function cleanDiscord(v) {
  const s = String(v == null ? "" : v).trim();
  if (!s) return "";
  if (!/^[\w.#\-]{2,40}$/.test(s)) return null; // null = invalid (distinct from "cleared")
  return s.slice(0, 40);
}

// Accept ONLY known boolean prefs. Unknown keys are dropped rather than stored, so a typo or
// a hostile body can never introduce a field that later reads as permissive somewhere else.
export function sanitizePrefs(incoming) {
  const out = {}; const rejected = [];
  if (!incoming || typeof incoming !== "object") return { prefs: out, rejected };
  for (const k of Object.keys(incoming)) {
    if (k === RIG_PREF && !RIG_FEATURE_LIVE) { rejected.push(k); continue; }
    if (!PREF_KEYS.includes(k)) { rejected.push(k); continue; }
    if (typeof incoming[k] !== "boolean") { rejected.push(k); continue; }
    out[k] = incoming[k];
  }
  return { prefs: out, rejected };
}

// Shape whatever came out of KV into a record we can trust. Anything unrecognised is
// discarded rather than carried forward.
export function normalizeMember(raw, now) {
  const r = (raw && typeof raw === "object") ? raw : {};
  const prefsIn = (r.prefs && typeof r.prefs === "object") ? r.prefs : {};
  const prefs = {};
  for (const k of PREF_KEYS) if (prefsIn[k] === true) prefs[k] = true; else if (prefsIn[k] === false) prefs[k] = false;
  return {
    discord: typeof r.discord === "string" ? r.discord : "",
    enlisted_at: Number.isFinite(r.enlisted_at) ? r.enlisted_at : now,
    status: STATUSES.includes(r.status) ? r.status : "ACTIVE",
    last_seen_at: Number.isFinite(r.last_seen_at) ? r.last_seen_at : now,
    prefs,
    rev: Number.isFinite(r.rev) ? r.rev : 1,
  };
}

// What OTHER members are allowed to see. Every field passes the strict gate; nothing is
// included "because it was probably fine". Callers render this, never the raw record.
export function publicView(member, cmdr) {
  const p = (member && member.prefs) || {};
  const named = visible(p, "show_on_roster");
  return {
    cmdr: named ? (cmdr || "") : "",          // unnamed members still COUNT, they just don't show
    named,
    discord: (named && visible(p, "link_discord_public")) ? (member.discord || "") : "",
    activity: visible(p, "show_activity"),
    credited: visible(p, "credit_contributions"),
    status: (member && member.status) || "ACTIVE",
  };
}

async function readCmdr(env, email) {
  try { const v = await env.BUILDS.get("cmdrlink:" + email); if (v) { const o = JSON.parse(v); if (o && o.cmdr) return String(o.cmdr); } } catch (e) {}
  return "";
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  const now = Date.now();

  let raw = null, existed = false;
  try { const v = await env.BUILDS.get(memberKey(me)); if (v != null) { existed = true; raw = JSON.parse(v); } } catch (e) {}

  let member;
  if (!existed) {
    // First sight. Reaching here means Access already let them in, which IS the approval
    // gate (the Allow-Blades policy is what an admin edits to admit a recruit). Write the
    // policy defaults EXPLICITLY so nothing downstream has to infer them.
    member = normalizeMember({ enlisted_at: now, last_seen_at: now, prefs: defaultPrefs(), rev: 1 }, now);
  } else {
    member = normalizeMember(raw, now);
    member.last_seen_at = now;   // drives MIA in phase 4; recorded on every sighting
  }
  try { await env.BUILDS.put(memberKey(me), JSON.stringify(member)); } catch (e) {}

  const cmdr = await readCmdr(env, me);
  return json({ ok: true, me, cmdr, provisioned: !existed, rigFeatureLive: RIG_FEATURE_LIVE, member });
}

export async function onRequestPatch({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const now = Date.now();

  let raw = null;
  try { const v = await env.BUILDS.get(memberKey(me)); if (v != null) raw = JSON.parse(v); } catch (e) {}
  const member = normalizeMember(raw, now);

  const { prefs, rejected } = sanitizePrefs(body.prefs);
  for (const k of Object.keys(prefs)) member.prefs[k] = prefs[k];

  if (Object.prototype.hasOwnProperty.call(body, "discord")) {
    const d = cleanDiscord(body.discord);
    if (d === null) return json({ ok: false, error: "invalid discord handle" }, 400);
    member.discord = d;
  }
  member.last_seen_at = now;
  member.rev = (member.rev || 1) + 1;

  try { await env.BUILDS.put(memberKey(me), JSON.stringify(member)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }

  const cmdr = await readCmdr(env, me);
  return json({ ok: true, me, cmdr, rejected, rigFeatureLive: RIG_FEATURE_LIVE, member });
}
