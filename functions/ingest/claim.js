// Cloudflare Pages Function — squad claims ledger for architect attribution.
//
// ColonisationSystemClaim only ever appears in the ARCHITECT's own journal, so a
// claim reported by a commander's plugin is first-party proof of who architected
// that system. The Blades Registrar plugin POSTs claims here — live as they
// happen, plus a one-time backfill scan of local journal history — and
// /ingest/build consults this ledger first when attributing an auto-created
// Raven build (claims -> Raven siblings -> fallback squad name).
//
// POST /ingest/claim
//   { key, systemAddress, systemName, cmdr, action:"claim"|"release", ts?, via? }
//   { key, via?, claims:[{ systemAddress, systemName, cmdr, action?, ts? }] }   <- backfill batch
//
// Storage: same BUILDS KV namespace, keys "claim:{systemAddress}" ->
// { architect, system, ts, via }. Build ids are GUIDs so the prefix can't
// collide; /blades/api/builds skips non-GUID keys when listing.
// Newest event timestamp wins — an old backfilled claim can't clobber a fresher
// live claim (or out-order a release). Public route (Access Bypass); the key is
// the gate, same as /ingest/build.
const SA = /^\d{1,20}$/;
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

async function applyOne(env, c, defaultVia) {
  const sa = String(c.systemAddress || "").trim();
  if (!SA.test(sa)) return "invalid";
  const action = c.action === "release" ? "release" : "claim";
  const cmdr = String(c.cmdr || "").trim();
  if (action === "claim" && (!cmdr || cmdr.toLowerCase() === "unknown")) return "invalid";
  const ts = Number(c.ts) || Date.now();
  const kvKey = "claim:" + sa;

  let existing = null;
  try { const v = await env.BUILDS.get(kvKey); if (v) existing = JSON.parse(v); } catch (e) {}
  // Stale event (backfill arriving after a newer live claim/release) — keep what we have.
  if (existing && existing.ts && ts < existing.ts) return "kept";

  if (action === "release") {
    if (existing) await env.BUILDS.delete(kvKey);
    return "released";
  }
  await env.BUILDS.put(kvKey, JSON.stringify({
    architect: cmdr.slice(0, 80),
    system: String(c.systemName || "").slice(0, 80),
    ts,
    via: String(c.via || defaultVia || "live").slice(0, 20),
  }));
  return "applied";
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  if (!env.INGEST_KEY || String(body.key || "") !== String(env.INGEST_KEY)) return json({ ok: false, error: "unauthorized" }, 401);

  const items = Array.isArray(body.claims) ? body.claims : [body];
  if (!items.length) return json({ ok: false, error: "no claims" }, 400);
  if (items.length > 200) return json({ ok: false, error: "too many claims (max 200 per POST)" }, 400);

  const out = { applied: 0, released: 0, kept: 0, invalid: 0 };
  for (const c of items) out[await applyOne(env, c, body.via)]++;
  return json({ ok: true, ...out });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades claims ledger. POST { key, systemAddress, systemName, cmdr, action } or { key, claims:[...] }." });
}
