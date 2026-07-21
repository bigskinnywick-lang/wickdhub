// Cloudflare Pages Function — ingest endpoint for the Blades Registrar EDMC plugin.
// POST /ingest/build  { key, marketId, systemAddress, cmdr }   (or { key, id })
// Validates the shared key, resolves the RavenColonial buildId from marketId+systemAddress,
// and upserts it into the same KV (BUILDS). Public route (Access Bypass) — the key is the gate.
const RAVEN = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net";
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  if (!env.INGEST_KEY || String(body.key || "") !== String(env.INGEST_KEY)) return json({ ok: false, error: "unauthorized" }, 401);

  let id = String(body.id || "").toLowerCase().trim();
  let name = "", system = "";
  if (!GUID.test(id) && body.marketId && body.systemAddress) {
    try {
      const p = await fetch(RAVEN + "/api/system/" + encodeURIComponent(body.systemAddress) + "/" + encodeURIComponent(body.marketId)).then(r => r.ok ? r.json() : null);
      if (p && p.buildId) { id = String(p.buildId).toLowerCase(); name = p.buildName || ""; system = p.systemName || ""; }
    } catch (e) {}
  }
  if (!GUID.test(id)) return json({ ok: false, error: "no build for that market yet" }, 404);

  const existing = await env.BUILDS.get(id);
  if (existing) return json({ ok: true, id, added: false });
  // fill name/system from Raven if we only had an id
  if (!name) { try { const p = await fetch(RAVEN + "/api/project/" + id).then(r => r.ok ? r.json() : null); if (p) { name = p.buildName || ""; system = p.systemName || ""; } } catch (e) {} }
  const meta = { name, system, addedBy: String(body.cmdr || "plugin"), ts: Date.now(), marketId: body.marketId || null, via: "registrar" };
  await env.BUILDS.put(id, JSON.stringify(meta));
  return json({ ok: true, id, added: true, name, system });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades Registrar ingest endpoint. POST { key, marketId, systemAddress, cmdr }." });
}
