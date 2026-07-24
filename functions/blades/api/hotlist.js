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
// SCALE — CACHED. The ticker polls this ~once a minute PER OPEN TAB, and computing it
// means scanning the whole KV namespace (builds are bare GUID keys with no prefix, so
// "list builds" can't be narrowed). To keep read volume flat as builds + squadmates
// pile in, the computed result is cached in "hot:cache" with a short self-expiring TTL:
// a hit serves ONE read; only the first poll after expiry re-scans. Claim mutations bust
// the cache (see my-claims.js) so pilot actions reflect immediately; everything else is at
// most CACHE_TTL_S stale, which is nothing against a day-granularity countdown.
//
// Completion can't be seen from KV (it lives in Raven), so we only distinguish
// "not_started" (no build record for the system) from "building" (a build exists). The
// dashboard, which already holds live Raven progress per build, drops any "building" row
// it can see is complete. Access-gated at the network layer -> any logged-in pilot reads it.
const WINDOW_DAYS = 28;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const CACHE_KEY = "hot:cache";
const CACHE_TTL_S = 180;               // 3 min — well under the day-level granularity of the countdown
const JHEAD = { "content-type": "application/json", "cache-control": "no-store" };
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: JHEAD });
const norm = (s) => String(s || "").toLowerCase().trim();

// Full namespace scan -> the hot list. Only runs on a cache miss.
async function compute(env) {
  const now = Date.now();
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
        if (m && !m.primaryDone) claims.push({ systemAddress: name.slice(6), system: m.system || "", architect: m.architect || "", ts: Number(m.ts) || 0 });
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
    hot.push({ systemAddress: c.systemAddress, system: c.system, architect: c.architect, claimTs: c.ts, daysLeft, tier: hasBuild ? "building" : "not_started" });
  }
  hot.sort((a, b) => (a.daysLeft - b.daysLeft) || ((a.tier === "not_started" ? 0 : 1) - (b.tier === "not_started" ? 0 : 1)));
  return { ok: true, now, windowDays: WINDOW_DAYS, hotlist: hot };
}

export async function onRequestGet({ env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);

  // Cache hit = one read. The key self-expires, so presence implies freshness.
  try {
    const cached = await env.BUILDS.get(CACHE_KEY);
    if (cached) return new Response(cached, { status: 200, headers: JHEAD });
  } catch (e) {}

  const body = JSON.stringify(await compute(env));
  try { await env.BUILDS.put(CACHE_KEY, body, { expirationTtl: CACHE_TTL_S }); } catch (e) {}
  return new Response(body, { status: 200, headers: JHEAD });
}
