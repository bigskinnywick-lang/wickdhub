// Cloudflare Pages Function — PUBLIC SQUAD NET feed: GalNet + Community Goals only.
//
// The full ticker (/blades/api/ticker) stays Access-gated and carries the member
// slots (squad notices) plus the client-rendered build traffic. THIS endpoint
// exposes only the two public news slots (galnet, cg) so the public home page can
// show them to logged-out prospects without leaking member or build data. Same KV
// source as ticker.js ("ticker:custom"), so one admin edit updates both feeds.
//
// GET /blades/api/ticker-public -> { ok, fields:[{key,label,text,expiresTs}] }
//
// Response is identical for everyone, so it is edge-cached for EDGE_TTL_S (a hit =
// zero KV ops). Readers are at most EDGE_TTL_S stale after an admin edit — fine for
// a news ticker; the member endpoint bust does not reach this cache.
//
// NOTE: for logged-out visitors to read this, the path must be reachable WITHOUT
// Cloudflare Access (a "Bypass"/"Allow Everyone" policy for /blades/api/ticker-public).
const EDGE_TTL_S = 60;

// Defaults mirror ticker.js so the feed still reads sensibly before an admin sets a
// slot; a saved value (including a deliberate blank = cleared) always wins.
const PUBLIC = [
  { key: "galnet", label: "GALNET", text: "10 Jun 3312 — Radicoida Unica ruled 'cultivated, not created': researchers say the Guardians farmed the rare bloom rather than engineering it, with archive data hinting they used it to sharpen their warriors. Also on the wire — Frontline Solutions expands rapid-response anti-piracy ops as an unidentified criminal fleet bearing strange insignia is sighted across several systems." },
  { key: "cg", label: "COMMUNITY GOALS", text: "Colonia Council Anniversary Celebrations — haul commodities & rare goods to Peters Base (Facece) for Colonia's 10th. Tier 2/5, ~21% in with 10k+ commanders, ~3 days left. Credit + cosmetic payouts scale with your contribution tier." },
];

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

async function loadPublic(env) {
  let saved = {};
  try { const v = await env.BUILDS.get("ticker:custom"); if (v) { const o = JSON.parse(v); if (o && Array.isArray(o.fields)) saved = Object.fromEntries(o.fields.map(f => [f.key, f])); } } catch (e) {}
  const now = Date.now();
  const out = [];
  for (const s of PUBLIC) {
    const f = saved[s.key];
    let text, label, expiresTs;
    if (f) { // explicitly set by an admin (including a deliberate clear) — respect it
      text = (typeof f.text === "string") ? f.text : "";
      label = (f.label != null && String(f.label).trim()) ? String(f.label) : s.label;
      expiresTs = f.expiresTs || null;
    } else { text = s.text; label = s.label; expiresTs = null; }
    if (!text || !String(text).trim()) continue;
    if (expiresTs && expiresTs < now) continue;
    out.push({ key: s.key, label, text, expiresTs });
  }
  return out;
}

export async function onRequestGet(context) {
  const { request, env, waitUntil } = context;
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound", fields: [] }, 500);
  const hit = await edgeMatch(request);
  if (hit) return hit;
  const resp = json({ ok: true, fields: await loadPublic(env) });
  resp.headers.set("Cache-Control", "public, max-age=" + EDGE_TTL_S);
  edgePut(request, resp, EDGE_TTL_S, waitUntil);
  return resp;
}
