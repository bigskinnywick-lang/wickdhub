// Cloudflare Pages Function — squad ship + cargo readout for the boards.
//
// "Who's flying what, and how much can they haul" — reads back what the Blades
// Registrar plugin reported to /ingest/loadout. Access-gated at the network layer
// (enlisted commanders only), edge-cached like presence so a board load costs zero
// KV ops on a cache hit.
//
// GET /blades/api/loadouts -> { ok, haulers:[{cmdr,ship,shipName,cargoCap,cargoUsed,ts,ageSec}], ts }
const EDGE_TTL_S = 20;
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
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
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
}

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound", haulers: [] }, 500);
  if (!callerEmail(request)) return json({ ok: false, error: "no identity", haulers: [] }, 403);
  const hit = await edgeMatch(request);
  if (hit) return hit;

  const now = Date.now();
  const haulers = [];
  try {
    const listing = await env.BUILDS.list({ prefix: "loadout:" });
    for (const k of listing.keys) {
      let rec = null;
      try { const v = await env.BUILDS.get(k.name); if (v) rec = JSON.parse(v); } catch (e) {}
      if (!rec || !rec.cmdr) continue;
      haulers.push({
        cmdr: rec.cmdr,
        ship: rec.ship || "",
        shipName: rec.shipName || "",
        cargoCap: rec.cargoCap || 0,
        cargoUsed: rec.cargoUsed || 0,
        ts: rec.ts || 0,
        ageSec: rec.ts ? Math.max(0, Math.round((now - rec.ts) / 1000)) : null,
      });
    }
  } catch (e) {}
  haulers.sort((a, b) => (b.cargoCap - a.cargoCap) || (b.ts - a.ts));

  const resp = json({ ok: true, haulers, ts: now });
  resp.headers.set("Cache-Control", "public, max-age=" + EDGE_TTL_S);
  edgePut(request, resp, EDGE_TTL_S, waitUntil);
  return resp;
}
