// Cloudflare Pages Function — squadron build registry (KV-backed)
// GET   /blades/api/builds       -> { builds: [{id,name,system,addedBy,ts,architect,architectSource,verified,completedTs,tons}] }
// POST  /blades/api/builds  {id,name?,system?} -> add a build to the shared list
// PATCH /blades/api/builds  {id, completedTs?, tons?, name?, system?, architect?, architectSource?, verified?}
//       -> field-whitelisted merge into the KV record. Used by the board to stamp
//          completion (so old builds stop costing a live Raven call per page load)
//          and to backfill architect attribution discovered from Raven/claims.
// KV binding: BUILDS (namespace onyx_builds). Gated to Blades by the /blades Cloudflare Access app.
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const json = (obj, status) => new Response(JSON.stringify(obj), {
  status: status || 200,
  headers: { "content-type": "application/json", "cache-control": "no-store" }
});

export async function onRequestGet({ env }) {
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
    return json({ builds });
  } catch (e) {
    return json({ builds: [], error: String(e) });
  }
}

export async function onRequestPost({ request, env }) {
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
  return json({ ok: true, id, name: meta.name, system: meta.system, addedBy });
}

// Board-driven metadata merge: completion stamp + architect backfill.
export async function onRequestPatch({ request, env }) {
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
  if (!Object.keys(set).length) return json({ ok: false, error: "nothing to update" }, 400);
  const merged = { ...meta, ...set };
  await env.BUILDS.put(id, JSON.stringify(merged));
  return json({ ok: true, id, meta: merged });
}

// Optional: remove a build from the shared list (not wired in UI yet)
export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const id = String(body.id || "").toLowerCase().trim();
  if (!GUID.test(id)) return json({ ok: false, error: "invalid build id" }, 400);
  await env.BUILDS.delete(id);
  return json({ ok: true, id });
}
