// Cloudflare Pages Function — the signed-in member's Registrar update state.
//
// Powers the "RESTART EDMC" ticker takeover. Resolves the caller (Access JWT) -> their
// bound CMDR -> the version their plugin last reported (KV "cmdrver:{cmdr}") and the
// release they SHOULD be on (channel-aware, same rule as navpull: test pilots -> beta,
// everyone else -> stable). If the running version is behind, needsRestart is true and
// the member ticker blares until the plugin reports the new version (after an EDMC
// restart), at which point it clears itself.
//
// GET /blades/api/plugin-status (Access-gated, per-pilot, no-store)
//   -> { ok, cmdr, running, pending, latest:{version,notes,url}|null, channel, needsRestart }
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
async function readJson(env, key) {
  try { const v = await env.BUILDS.get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
async function resolveCmdr(env, email) {
  const o = await readJson(env, "cmdrlink:" + email);
  return (o && o.cmdr) ? String(o.cmdr) : "";
}
async function hasRole(env, cmdrLower, role) {
  const m = await readJson(env, "plugin:roles");
  const r = m && m[cmdrLower];
  return Array.isArray(r) && r.map(x => String(x).toLowerCase()).includes(String(role).toLowerCase());
}
function pubRelease(r) {
  if (!r || !r.version) return null;
  return { version: String(r.version), notes: r.notes || "", url: r.url || "" };
}
// Compare by numeric components only (letters, e.g. a beta marker, are ignored for
// ordering): "2.1" vs "2.2" -> -1; "b2.1" vs "2.1" -> 0.
function numParts(v) { return (String(v || "").match(/\d+/g) || []).map(n => parseInt(n, 10)); }
function cmpVer(a, b) {
  const A = numParts(a), B = numParts(b), n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i++) { const x = A[i] || 0, y = B[i] || 0; if (x !== y) return x < y ? -1 : 1; }
  return 0;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  // Signed in but no CMDR bound = setup not finished -> nudge to complete setup.
  if (!cmdr) return json({ ok: true, cmdr: "", running: "", pending: "", latest: null, channel: "stable", needsRestart: false, needsSetup: true, testPilot: false });
  const cmdrLower = cmdr.toLowerCase();

  const ver = await readJson(env, "cmdrver:" + cmdrLower);
  const running = (ver && ver.running) ? String(ver.running) : "";
  const pending = (ver && ver.pending) ? String(ver.pending) : "";

  const channel = (await hasRole(env, cmdrLower, "testpilot")) ? "beta" : "stable";
  let rel = await readJson(env, "plugin:release:" + channel);
  if (!rel && channel === "beta") rel = await readJson(env, "plugin:release:stable");
  const latest = pubRelease(rel);

  // Nag to RESTART when a heard-from pilot is behind; nag to COMPLETE SETUP when we
  // have no heartbeat at all (no plugin, a pre-2.0 plugin that can't report, or a
  // plugin whose heartbeat has aged out).
  // A pilot should be running EXACTLY their channel's latest build. If we've heard from
  // them and they're on anything else, nag to restart — symmetric, so entering beta,
  // leaving beta (revoke), a plain upgrade, and a staged-not-yet-restarted build all fire
  // the same way. Clears the instant the plugin reports the target version.
  const needsRestart = !!(running && latest && running !== latest.version);
  const needsSetup = !running;
  return json({ ok: true, cmdr, running, pending, latest, channel, needsRestart, needsSetup, testPilot: channel === "beta" });
}
