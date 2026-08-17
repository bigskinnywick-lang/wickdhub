// Cloudflare Pages Function — full KV namespace export (backup).
// GET /blades/api/export  -> one JSON blob of the entire onyx_builds namespace.
//   { version, exportedTs, exportedBy, buildCount, claimCount, builds:{id:rec},
//     claims:{"claim:sa":rec}, admins:[...], other:{key:rec}, redacted:{...} }
//
// ⚠ THIS BLOB IS COMMITTED TO A PUBLIC GIT REPO. Personal keys (member records, rig data,
// email->CMDR bindings) are therefore REDACTED BY DEFAULT — they are counted, never dumped.
// A backup that quietly publishes the data members consented to keep private is worse than
// no backup. Pass ?include=personal for a FULL dump when restoring; that file must never be
// committed. The response always states which mode produced it, so a blob is self-describing.
//
// Admin-gated. Walks the whole namespace with cursor pagination (correct beyond the
// current ~kilobyte scale). This is the backup source: the admin console's
// "Download backup" button saves this blob to a file, which Adam drops into the repo
// backups/ folder and pushes via GitHub Desktop — git becomes the versioned, diffable,
// offsite backup. /blades/api/import is the recovery counterpart.
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// Key families whose WHOLE RECORD is personal — dropped entirely in safe mode.
// 2026-08-16 — device credentials added. Two reasons they belong here, and the
// second is the one that actually matters:
//   1. Even hashed, a credential record has no business riding in a backup that
//      lands in a git repo.
//   2. A device record carries the PC's NAME and country. Two commanders paired
//      from the same machine sit next to each other in the dump with identical
//      device names — which correlates two identities that are deliberately not
//      correlated anywhere else in this system. The hash is the boring risk; the
//      adjacency is the real one.
const PERSONAL_PREFIXES = ["member:", "rig:", "cmdrlink:", "sq:onyx:devtoken:", "sq:onyx:devices:", "sq:onyx:pair:"];
function isPersonal(name) { return PERSONAL_PREFIXES.some(p => String(name).startsWith(p)); }

// ⚠ A prefix list alone is NOT enough, and assuming it was is a real bug we shipped once.
// Emails also sit in VALUES scattered across unrelated families — admiral:emails, btype:*
// (who set it), carrierlink:*, home:wisdom, plugin:release:*, ticker:custom — and inside
// KEY NAMES (check:{feature}:{email}). Any new family can add another tomorrow. So safe mode
// also pseudonymises every email in the serialised blob, whatever key it came from: this
// catches families nobody remembered, which is the whole point.
//
// Deterministic, so structure survives — the same person maps to the same token everywhere,
// keys stay unique, and relationships stay readable. It is deliberately NOT reversible.
function pseudonymiseEmails(text) {
  const map = new Map();
  const out = String(text).replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, (m) => {
    const k = m.toLowerCase();
    if (!map.has(k)) map.set(k, "member" + (map.size + 1) + "@redacted.invalid");
    return map.get(k);
  });
  return { out, count: map.size };
}
const OWNER = "bigskinnywick@gmail.com";
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

  const includePersonal = new URL(request.url).searchParams.get("include") === "personal";
  const builds = {}, claims = {}, other = {};
  const redactedCounts = {};
  let admins = [];
  let cursor;
  do {
    const l = await env.BUILDS.list({ cursor });
    for (const k of l.keys) {
      if (isPersonal(k.name) && !includePersonal) {
        const pfx = PERSONAL_PREFIXES.find(p => k.name.startsWith(p));
        redactedCounts[pfx] = (redactedCounts[pfx] || 0) + 1;
        continue;                       // counted, never read, never emitted
      }
      let val = null;
      try { const v = await env.BUILDS.get(k.name); if (v != null) { try { val = JSON.parse(v); } catch (e) { val = v; } } } catch (e) {}
      if (k.name === "admin:emails") { admins = Array.isArray(val) ? val : []; }
      else if (k.name.startsWith("claim:")) { claims[k.name] = val; }
      else if (GUID.test(k.name)) { builds[k.name] = val; }
      else { other[k.name] = val; }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);

  const payload = {
    version: 1,
    exportedTs: Date.now(),
    exportedBy: callerEmail(request),
    buildCount: Object.keys(builds).length,
    claimCount: Object.keys(claims).length,
    builds, claims, admins, other,
    redacted: {
      mode: includePersonal ? "FULL — CONTAINS PERSONAL DATA, DO NOT COMMIT" : "safe — personal keys dropped, emails pseudonymised",
      personalIncluded: includePersonal,
      prefixes: PERSONAL_PREFIXES,
      counts: redactedCounts,
      emailsPseudonymised: 0,
    },
  };

  if (includePersonal) return json(payload);

  // Safe mode: scrub the SERIALISED blob, so nothing depends on knowing where emails live.
  const { out, count } = pseudonymiseEmails(JSON.stringify(payload));
  const safe = JSON.parse(out);
  safe.redacted.emailsPseudonymised = count;
  return json(safe);
}
