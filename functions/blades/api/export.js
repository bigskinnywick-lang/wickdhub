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
// Key prefixes that carry personal data. Add to this list BEFORE shipping any new key family
// that names a person — the default must be redaction, not remembering to redact.
const PERSONAL_PREFIXES = ["member:", "rig:", "cmdrlink:"];
function isPersonal(name) { return PERSONAL_PREFIXES.some(p => String(name).startsWith(p)); }
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

  return json({
    version: 1,
    exportedTs: Date.now(),
    exportedBy: callerEmail(request),
    buildCount: Object.keys(builds).length,
    claimCount: Object.keys(claims).length,
    builds, claims, admins, other,
    redacted: {
      mode: includePersonal ? "FULL — CONTAINS PERSONAL DATA, DO NOT COMMIT" : "safe — personal keys omitted",
      personalIncluded: includePersonal,
      prefixes: PERSONAL_PREFIXES,
      counts: redactedCounts,
    },
  });
}
