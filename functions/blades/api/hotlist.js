// Cloudflare Pages Function — architect "hot list": claimed systems whose 4-week
// primary-port window is ticking and that haven't been built yet.
//
// GET /blades/api/hotlist -> { now, windowDays, hotlist:[{ systemAddress, system,
//                             architect, claimTs, daysLeft, tier }] }
//
// A colonisation claim gives the architect ~4 weeks to deploy the primary port or
// the claim is revoked (ColonisationSystemClaimRelease never fires on COMPLETION, so
// a live claim in-window with no build is a genuine at-risk lead — not stale noise).
// We window OUT claims older than the deadline so long-finished colonies (whose build
// record we may simply be missing) don't spam the feed as fake "expired".
//
// Cheap + KV-only so the ticker can poll it: no per-claim Raven calls. Completion
// can't be seen from KV (it lives in Raven), so we only distinguish "not_started"
// (no build record for the system) from "building" (a build exists). The dashboard,
// which already holds live Raven progress per build, drops any "building" row it can
// see is actually complete. Access-gated at the network layer -> any logged-in pilot
// may read it (NOT admin-only), because pilots need to see their own at-risk claims.
const WINDOW_DAYS = 28;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const norm = (s) => String(s || "").toLowerCase().trim();

export async function onRequestGet({ env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const now = Date.now();

  // One pass over the namespace: collect claims and the set of systems that have a build.
  const claims = [];
  const builtSystems = new Set();
  let cursor;
  do {
    const l = await env.BUILDS.list({ cursor });
    for (const k of l.keys) {
      const name = k.name;
      if (name.startsWith("claim:")) {
        let m = null;
        try { const v = await env.BUILDS.get(name); if (v) m = JSON.parse(v); } catch (e) {}
        if (m) claims.push({ systemAddress: name.slice(6), system: m.system || "", architect: m.architect || "", ts: Number(m.ts) || 0 });
      } else if (GUID.test(name)) {
        let m = null;
        try { const v = await env.BUILDS.get(name); if (v) m = JSON.parse(v); } catch (e) {}
        if (m && m.system) builtSystems.add(norm(m.system));
      }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);

  const hot = [];
  for (const c of claims) {
    if (!c.ts) continue;                       // no timestamp -> can't judge the window, skip
    const age = now - c.ts;
    if (age < 0 || age > WINDOW_MS) continue;  // window OUT stale/old claims (fake-expired guard)
    const hasBuild = c.system && builtSystems.has(norm(c.system));
    const daysLeft = Math.max(0, Math.ceil((c.ts + WINDOW_MS - now) / 86400000));
    hot.push({
      systemAddress: c.systemAddress,
      system: c.system,
      architect: c.architect,
      claimTs: c.ts,
      daysLeft,
      tier: hasBuild ? "building" : "not_started",
    });
  }

  // Most urgent first: fewest days left, and not-started ahead of building on a tie.
  hot.sort((a, b) => (a.daysLeft - b.daysLeft) || ((a.tier === "not_started" ? 0 : 1) - (b.tier === "not_started" ? 0 : 1)));

  return json({ ok: true, now, windowDays: WINDOW_DAYS, hotlist: hot });
}
