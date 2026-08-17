// Cloudflare Pages Function — admin management of member roles.
//
// First brick of a wider roles system. KV "plugin:roles" is a map { cmdrLower:
// ["testpilot","officer",...] }. Today only "testpilot" is load-bearing: it grants
// ELIGIBILITY — the board offers that pilot the beta test-track switch. It does NOT force
// the channel; the pilot's own switch (KV "plugin:tier", read by navpull/plugin-status)
// decides that. The one channel side effect here: REVOKING test-pilot clears the pilot's
// tier so their registrar demotes back to retail. The existing email-based admin gate
// stays separate for now.
//
// GET  /blades/api/plugin-roles  (admin) -> { ok, roles, pilots:[{cmdr,running,pending,ts}] }
// POST /blades/api/plugin-roles  (admin) { cmdr, roles:[...] } -> { ok, roles }  (empty roles clears the entry)
const OWNER = "bigskinnywick@gmail.com";
const ALLOWED = ["member", "testpilot", "officer", "admin"];
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
async function adminList(env) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(x => String(x).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER);
  return admins;
}
async function isAdmin(request, env) { const e = callerEmail(request); return !!e && (await adminList(env)).includes(e); }
// ★ Hardcoded, never KV-driven — see the full note in admins.js. Role grants are PERSONNEL,
// not technical ops: this is the QUARTERMASTER's lane (what you hold once inside) and it
// parks with the owner until that desk exists. GET stays on isAdmin — reading the roster
// changes nothing.
function isOwner(request) { return callerEmail(request) === OWNER; }
function cleanCmdr(v) { const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim(); return /^[\w .'\-]{1,40}$/.test(s) ? s.slice(0, 40) : ""; }
function cleanRoles(arr) {
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const x of arr) { const r = String(x || "").toLowerCase().trim(); if (ALLOWED.includes(r) && !out.includes(r)) out.push(r); }
  return out;
}
// All known member CMDRs, for the admin "add pilot" dropdown. Sourced from bound
// CMDRs (cmdrlink:*), plugins that have reported (cmdrver:*), and existing role keys.
async function listMembers(env) {
  const map = {}; // lowerName -> displayName
  try { const l = await env.BUILDS.list({ prefix: "cmdrlink:" }); for (const k of (l.keys || [])) { const o = await readJson(env, k.name); if (o && o.cmdr) { const d = String(o.cmdr); map[d.toLowerCase()] = d; } } } catch (e) {}
  try { const l = await env.BUILDS.list({ prefix: "cmdrver:" }); for (const k of (l.keys || [])) { const nm = k.name.slice("cmdrver:".length); if (nm && !map[nm.toLowerCase()]) map[nm.toLowerCase()] = nm; } } catch (e) {}
  // claim architects (e.g. system owners like TEMPLAR57 who never bound / never ran the plugin),
  // skipping the "Onyx Blades" squad fallback which is not a commander.
  try { const l = await env.BUILDS.list({ prefix: "claim:" }); for (const k of (l.keys || [])) { const o = await readJson(env, k.name); const a = o && o.architect ? String(o.architect).trim() : ""; if (a && a.toLowerCase() !== "onyx blades" && !map[a.toLowerCase()]) map[a.toLowerCase()] = a; } } catch (e) {}
  try { const roles = (await readJson(env, "plugin:roles")) || {}; Object.keys(roles).forEach(c => { if (!map[c.toLowerCase()]) map[c.toLowerCase()] = c; }); } catch (e) {}
  return Object.values(map).sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}
async function listPilots(env) {
  const out = [];
  try {
    const list = await env.BUILDS.list({ prefix: "cmdrver:" });
    for (const k of (list.keys || [])) {
      const rec = await readJson(env, k.name);
      if (rec) out.push({ cmdr: k.name.slice("cmdrver:".length), running: rec.running || "", pending: rec.pending || "", ts: rec.ts || 0 });
    }
  } catch (e) {}
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

// ── MIGRATION READINESS (2026-08-16) ────────────────────────────────────────
// Built because the gate I first proposed was unsound. "Watch cmdrver: until
// everyone is on a pairing-capable build" reads as done when it is merely
// FORGETFUL: cmdrver has a 14-day TTL, so a pilot who stays away simply stops
// being counted and the list looks complete. Same failure as a queue reporting
// `waiting: 0` because nothing ever reached the queue.
//
// So this is built from DURABLE keys — cmdrlink (a binding, permanent) and
// sq:*:devices (a pairing, permanent) — and it reports `unknown` rather than
// inferring anything from an absence. An empty version is "we cannot see him",
// never "he is fine".
//
// It also answers the question that actually blocks a pilot: they cannot approve
// a device until their CMDR is BOUND, and nobody can bind it for them.
async function migrationReadiness(env, members) {
  const bound = new Set();
  try {
    const l = await env.BUILDS.list({ prefix: "cmdrlink:" });
    for (const k of (l.keys || [])) {
      const o = await readJson(env, k.name);
      if (o && o.cmdr) bound.add(String(o.cmdr).toLowerCase());
    }
  } catch (e) {}

  const paired = new Map();
  try {
    const l = await env.BUILDS.list({ prefix: "sq:onyx:devices:" });
    for (const k of (l.keys || [])) {
      const arr = await readJson(env, k.name);
      if (Array.isArray(arr) && arr.length) {
        paired.set(k.name.slice("sq:onyx:devices:".length), arr.length);
      }
    }
  } catch (e) {}

  const retired = new Map();
  try {
    const l = await env.BUILDS.list({ prefix: "sq:onyx:retired:" });
    for (const k of (l.keys || [])) {
      const o = await readJson(env, k.name);
      retired.set(k.name.slice("sq:onyx:retired:".length), o || {});
    }
  } catch (e) {}

  const vers = new Map();
  try {
    const l = await env.BUILDS.list({ prefix: "cmdrver:" });
    for (const k of (l.keys || [])) {
      const rec = await readJson(env, k.name);
      if (rec) vers.set(k.name.slice("cmdrver:".length), rec);
    }
  } catch (e) {}

  // A build can pair only if it HAS pairing in it: b3.33+ on beta, 3.2+ on retail.
  const canPair = (v) => {
    const s = String(v || "");
    if (!s) return null;                       // unknown, not false
    const n = (s.match(/\d+/g) || []).map(Number);
    if (!n.length) return null;
    const beta = /[A-Za-z]/.test(s);
    if (beta) return n[0] > 3 || (n[0] === 3 && (n[1] || 0) >= 33);
    return n[0] > 3 || (n[0] === 3 && (n[1] || 0) >= 2);
  };

  return members.map((cmdr) => {
    const lc = cmdr.toLowerCase();
    const v = vers.get(lc);
    const running = (v && v.running) || "";
    const devices = paired.get(lc) || 0;

    // ── Is there anything to migrate for this commander at all? ─────────────
    // The first cut of this gate demanded a paired device from EVERY name in the
    // roster, and could therefore never go green: listMembers deliberately
    // includes claim architects who have never run the plugin, and alts that no
    // account is bound to. A gate that cannot be satisfied gets ignored, which
    // is worse than no gate.
    //
    // So there are three states, not a boolean. Only a commander with actual
    // PLUGIN EVIDENCE can strand, because only a plugin gets refused.
    const hasPlugin = !!(v || devices);
    const ret = retired.get(lc) || null;

    // A retired registrar does not block — being refused is the point. But a
    // retired plugin that is STILL REPORTING is a contradiction between the
    // record and reality, and reality wins: say so rather than letting a stale
    // decision quietly cover a live plugin.
    const RECENT_MS = 1000 * 60 * 60 * 24 * 2;
    const stillReporting = !!(ret && v && v.ts && (Date.now() - v.ts) < RECENT_MS);

    const state = ret ? "retired"
      : !hasPlugin ? "n/a"
      : (bound.has(lc) && devices > 0) ? "ready"
      : "blocked";

    return {
      cmdr,
      bound: bound.has(lc),                    // can they approve at all?
      paired: devices,                         // durable — survives a silent pilot
      running: running || null,
      lastSeenTs: (v && v.ts) || 0,
      canPair: canPair(running),               // null = we genuinely do not know
      hasPlugin,
      state,
      retired: ret ? { by: ret.by || "", ts: ret.ts || 0, reason: ret.reason || "" } : null,
      stillReporting,
      // Kept for callers that just want the boolean. n/a is NOT ready — it is
      // "nothing to do", which the card must say out loud rather than imply.
      ready: state === "ready",
    };
  });
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  const members = await listMembers(env);
  const migration = await migrationReadiness(env, members);
  return json({
    ok: true,
    roles: (await readJson(env, "plugin:roles")) || {},
    allowed: ALLOWED,
    pilots: await listPilots(env),
    members,
    migration,
    // Only a BLOCKED row can strand anyone. An "n/a" row has no plugin we have
    // ever seen, so there is nothing for the switch to refuse.
    //
    // ⚠ The residual risk, stated rather than hidden: if such a commander has an
    // installation that has never once reported, flipping the switch strands it.
    // Waiting would not help — an invisible plugin cannot be waited for. The card
    // says this out loud instead of quietly counting it as fine.
    migrationReady: migration.every((m) => m.state !== "blocked"),
    migrationBlocked: migration.filter((m) => m.state === "blocked").map((m) => m.cmdr),
  });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  // OWNER ONLY for now — personnel, the quartermaster's lane once that desk exists.
  if (!isOwner(request)) return json({ ok: false, error: "forbidden — owner only" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const cmdr = cleanCmdr(body.cmdr);
  if (!cmdr) return json({ ok: false, error: "valid cmdr required" }, 400);

  // ── RETIRE / UN-RETIRE a registrar ────────────────────────────────────────
  // For a commander whose plugin should stop reporting — an alt, a decommissioned
  // PC, someone who left. Retiring does NOT silence anything: the switch-off is
  // what actually stops that plugin, and this simply records that being refused
  // is the INTENDED outcome for this commander rather than an accident.
  //
  // Deliberately a decision with a name and a date on it, not a hidden exclusion.
  // A gate you can quietly edit is not a gate. And if a retired plugin keeps
  // reporting, the card says so out loud rather than letting the record win over
  // the observation.
  if (Object.prototype.hasOwnProperty.call(body, "retire")) {
    const rk = "sq:onyx:retired:" + cmdr.toLowerCase();
    try {
      if (body.retire) {
        await env.BUILDS.put(rk, JSON.stringify({
          by: callerEmail(request),
          ts: Date.now(),
          reason: String(body.reason || "").slice(0, 120),
        }));
      } else {
        await env.BUILDS.delete(rk);
      }
    } catch (e) { return json({ ok: false, error: "write failed" }, 500); }
    const members2 = await listMembers(env);
    const migration2 = await migrationReadiness(env, members2);
    return json({
      ok: true, cmdr, retired: !!body.retire,
      migration: migration2,
      migrationReady: migration2.every((m) => m.state !== "blocked"),
    });
  }

  const roles = cleanRoles(body.roles);
  const map = (await readJson(env, "plugin:roles")) || {};
  const key = cmdr.toLowerCase();
  const hadTestpilot = Array.isArray(map[key]) && map[key].map(x => String(x).toLowerCase()).includes("testpilot");
  if (roles.length) map[key] = roles; else delete map[key];
  try { await env.BUILDS.put("plugin:roles", JSON.stringify(map)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }

  // Admin promote/revoke controls ELIGIBILITY, not the channel — with ONE exception:
  // REVOKING test-pilot must DEMOTE that pilot's registrar back to retail (their beta
  // clearance is gone, so they can't be left armed). GRANTING never forces beta — the
  // pilot stays on retail until they flick their OWN switch. So the only thing we ever do
  // to the tier here is CLEAR it on a revoke; we never set beta.
  const nowTestpilot = roles.includes("testpilot");
  if (hadTestpilot && !nowTestpilot) {
    try {
      const tiers = (await readJson(env, "plugin:tier")) || {};
      if (tiers[key]) { delete tiers[key]; await env.BUILDS.put("plugin:tier", JSON.stringify(tiers)); }
    } catch (e) {}
  }
  return json({ ok: true, roles: map });
}
