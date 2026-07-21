// Cloudflare Pages Function — squadron build registry (KV-backed)
// GET  /blades/api/builds       -> { builds: [{id,name,system,addedBy,ts}] }
// POST /blades/api/builds  {id,name?,system?} -> add a build to the shared list
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
      let meta = {};
      try { const v = await env.BUILDS.get(k.name); if (v) meta = JSON.parse(v); } catch (e) {}
      builds.push({ id: k.name, name: meta.name || "", system: meta.system || "", addedBy: meta.addedBy || "", ts: meta.ts || null });
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
