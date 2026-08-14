// Cloudflare Pages Function — squadron build registry (KV-backed)
// GET   /blades/api/builds       -> { builds: [{id,name,system,addedBy,ts,architect,architectSource,verified,completedTs,tons}] }
// POST  /blades/api/builds  {id,name?,system?} -> add a build to the shared list
// PATCH /blades/api/builds  {id, completedTs?, tons?, name?, system?, architect?, architectSource?, verified?, unset?:[...] }
//       -> field-whitelisted merge into the KV record. Used by the board to stamp
//          completion (so old builds stop costing a live Raven call per page load)
//          and to backfill architect attribution discovered from Raven/claims.
//       `unset` (admin console) removes whitelisted fields.
// KV binding: BUILDS (namespace onyx_builds). Gated to Blades by the /blades Cloudflare Access app.
//
// SCALE — EDGE-CACHED. The board + dashboard GET this on every load and auto-refresh,
// and the GET scans the whole KV namespace (list + one read per GUID) — the single most
// expensive read path in the app. We cache the GET response in the colo edge cache
// (caches.default) for EDGE_TTL_S: a hit costs ZERO KV operations (unlike a KV-backed
// cache, which still spends one read). Only requests that already passed Cloudflare
// Access ever reach this Function, so the cache is never served to the public. Any
// write (POST/PATCH/DELETE) purges the cached GET so the writer sees fresh data
// immediately; ingest-driven writes fall in under EDGE_TTL_S, which is nothing against
// the board's own refresh cadence.
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const EDGE_TTL_S = 30;
const json = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});
// One shared cache entry for all members: key is the bare URL (no auth headers).
const cacheKeyFor = (request) => new Request(new URL(request.url).origin + new URL(request.url).pathname);
async function edgeMatch(request) { try { return await caches.default.match(cacheKeyFor(request)); } catch (e) { return null; } }
function edgePut(request, resp, ttl, waitUntil) {
  try {
    const r = resp.clone();
    r.headers.set("Cache-Control", "public, max-age=" + ttl);
    const p = caches.default.put(cacheKeyFor(request), r);
    if (waitUntil) waitUntil(p);
  } catch (e) {}
}
function edgeBust(request, waitUntil) {
  try { const p = caches.default.delete(cacheKeyFor(request)); if (waitUntil) waitUntil(p); } catch (e) {}
}

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  const hit = await edgeMatch(request);
  if (hit) return hit;
  if (!env || !env.BUILDS) return json({ builds: [], error: "KV not bound" });
  try {
    const listing = await env.BUILDS.list();
    const builds = [];
    for (const k of listing.keys) {
      // Build keys are GUIDs. Skip everything else — notably the "claim:{systemAddress}"
      // claims-ledger keys written by /ingest/claim (architect attribution).
      if (!GUID.test(k.name)) continue;
      let meta = {};
      try { const v = await env.BUILDS.get(k.name); if (v) meta = JSON.parse(v); } catch (e) {}
      builds.push({
        id: k.name, name: meta.name || "", system: meta.system || "", addedBy: meta.addedBy || "", ts: meta.ts || null,
        architect: meta.architect || "", architectSource: meta.architectSource || "", verified: !!meta.verified,
        completedTs: meta.completedTs || null, tons: meta.tons || null,
      });
    }
    const resp = json({ builds });
    resp.headers.set("Cache-Control", "public, max-age=" + EDGE_TTL_S);
    edgePut(request, resp, EDGE_TTL_S, waitUntil);
    return resp;
  } catch (e) {
    return json({ builds: [], error: String(e) });
  }
}

export async function onRequestPost(context) {
  const { request, env, waitUntil } = context;
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const id = String(body.id || "").toLowerCase().trim();
  if (!GUID.test(id)) return json({ ok: false, error: "invalid build id" }, 400);
  const addedBy = request.headers.get("Cf-Access-Authenticated-User-Email") || "unknown";
  const meta = {
    name: String(body.name || "").slice(0, 80),
    system: String(body.system || "").slice(0, 80),
    addedBy,
    ts: Date.now()
  };
  await env.BUILDS.put(id, JSON.stringify(meta));
  edgeBust(request, waitUntil);
  return json({ ok: true, id, name: meta.name, system: meta.system, addedBy });
}

// --- auto-unassign carriers when a build completes ---------------------------------
// A finished site needs no mobile depot, and RavenColonial neither blocks a link to a
// completed build nor clears one on completion (measured 2026-08-14: three completed
// builds were still carrying carriers). A carrier holds ONE hold of cargo, so a stale
// link keeps offering that tonnage to a build nobody is hauling to.
//
// ★ SCOPE, Adam's call 2026-08-14: clear only carriers we can identify as SQUADRON-owned,
// i.e. present in our own "carrier:{marketId}" registry. Outsiders' carriers are left
// alone — these projects are not ours in Raven, and removing a stranger's arrangement is
// not a side effect a completion stamp should have.
//
// ★ TRIGGER: this piggybacks the completion stamp the colonisation board already writes
// (it detects Raven's `complete` and PATCHes completedTs). There is no scheduler, so this
// fires when a pilot next views the finished build — not at the instant of completion.
// Only on the TRANSITION (no completedTs before, one now), so it cannot re-run on every
// later PATCH and cannot fight a pilot who deliberately re-links.
const RAVEN_BASE = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net";
const RAVEN_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const RAVEN_TIMEOUT_MS = 6000;
async function ravenCall(path, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAVEN_TIMEOUT_MS);
  try { return await fetch(RAVEN_BASE + path, Object.assign({ headers: { "User-Agent": RAVEN_UA, "Accept": "application/json" } }, init || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(timer); }
}
async function unassignSquadCarriers(env, buildId) {
  const cleared = [];
  try {
    const r = await ravenCall("/api/project/" + buildId);
    if (!r.ok) return cleared;
    const p = await r.json();
    const fc = (p && Array.isArray(p.linkedFC)) ? p.linkedFC : [];
    for (const f of fc) {
      const mid = String((f && f.marketId) || f || "").trim();
      if (!/^\d{1,20}$/.test(mid)) continue;
      // Ours, or a stranger's? The registry is the only thing that can tell us.
      let known = null;
      try { const v = await env.BUILDS.get("carrier:" + mid); if (v) known = JSON.parse(v); } catch (e) {}
      if (!known) continue;
      let ok = false, status = 0;
      try { const d = await ravenCall("/api/project/" + buildId + "/fc/" + mid, { method: "DELETE" }); status = d.status; ok = d.ok; } catch (e) {}
      if (ok) cleared.push(mid);
      try {
        await env.BUILDS.put("carrierlink:" + mid + ":" + Date.now(), JSON.stringify({
          buildId, marketId: mid, cmdr: known.owner || "", action: "auto-unlink",
          reason: "build_completed", status, ok, ts: Date.now(),
        }), { expirationTtl: 60 * 60 * 24 * 90 });
      } catch (e) {}
    }
  } catch (e) {}
  return cleared;
}

// Board-driven metadata merge: completion stamp + architect backfill. Admin console
// additionally uses `unset` to remove whitelisted fields.
const UNSETTABLE = new Set(["completedTs", "tons", "architect", "architectSource", "verified"]);
export async function onRequestPatch(context) {
  const { request, env, waitUntil } = context;
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const id = String(body.id || "").toLowerCase().trim();
  if (!GUID.test(id)) return json({ ok: false, error: "invalid build id" }, 400);
  const v = await env.BUILDS.get(id);
  if (!v) return json({ ok: false, error: "not found" }, 404);
  let meta = {};
  try { meta = JSON.parse(v) || {}; } catch (e) {}
  const set = {};
  if (body.completedTs !== undefined) { const t = Number(body.completedTs); if (t > 0) set.completedTs = t; }
  if (body.tons !== undefined) { const t = Number(body.tons); if (t >= 0) set.tons = t; }
  if (typeof body.name === "string" && body.name.trim()) set.name = body.name.trim().slice(0, 80);
  if (typeof body.system === "string" && body.system.trim()) set.system = body.system.trim().slice(0, 80);
  if (typeof body.architect === "string" && body.architect.trim()) {
    set.architect = body.architect.trim().slice(0, 80);
    set.architectSource = typeof body.architectSource === "string" && body.architectSource ? body.architectSource.slice(0, 20) : "board";
    set.verified = body.verified !== undefined ? !!body.verified : true;
  }
  const unset = Array.isArray(body.unset) ? body.unset.filter(f => UNSETTABLE.has(f)) : [];
  if (!Object.keys(set).length && !unset.length) return json({ ok: false, error: "nothing to update" }, 400);
  const merged = { ...meta, ...set };
  for (const f of unset) delete merged[f];
  await env.BUILDS.put(id, JSON.stringify(merged));
  edgeBust(request, waitUntil);

  // The build just CROSSED into completed — clear squadron carriers off it. Deliberately
  // after the KV write and, where the platform allows, after the response: this is tidy-up,
  // and it must never make the stamp slower or able to fail. A Raven outage simply means
  // the links stay until the next completion stamp somewhere, which is harmless.
  const justCompleted = !meta.completedTs && !!merged.completedTs;
  if (justCompleted) {
    const sweep = unassignSquadCarriers(env, id);
    if (waitUntil) waitUntil(sweep); else await sweep.catch(() => {});
  }

  return json({ ok: true, id, meta: merged, carriersCleared: justCompleted || undefined });
}

// Remove a build from the shared list.
export async function onRequestDelete(context) {
  const { request, env, waitUntil } = context;
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const id = String(body.id || "").toLowerCase().trim();
  if (!GUID.test(id)) return json({ ok: false, error: "invalid build id" }, 400);
  await env.BUILDS.delete(id);
  edgeBust(request, waitUntil);
  return json({ ok: true, id });
}
