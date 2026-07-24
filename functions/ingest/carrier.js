// Cloudflare Pages Function — squad fleet-carrier registry for the Blades Registrar plugin.
//
// A fleet carrier's ownership only appears in the OWNER's own journal (CarrierStats),
// so a carrier reported by a commander's plugin is first-party proof of who owns it.
// The plugin POSTs carriers here — live when CarrierStats fires, plus a one-time
// backfill scan of local journal history — and the commander deck / carrier-link
// relay read it back to offer "link my carrier to this build".
//
// For a fleet carrier CarrierID == MarketID (same value in CarrierStats & CarrierJump),
// so the reported marketId is exactly what RavenColonial's PUT /api/project/{id}/fc/{marketId}
// expects.
//
// POST /ingest/carrier
//   { key, marketId, callsign, name, cmdr, ts?, via? }
//   { key, via?, carriers:[{ marketId, callsign, name, cmdr, ts? }] }   <- backfill batch
//
// Storage: same BUILDS KV namespace.
//   "carrier:{marketId}"     -> { marketId, callsign, name, owner, ts, via }
//   "cmdrcarrier:{cmdrLower}" -> { marketId, ts }   (reverse index; newest ts wins)
// Both non-GUID keys so they ride in export other{} (backed up). Newest event
// timestamp wins so an old backfilled record can't clobber a fresher live one.
// Public route (Access Bypass); the key is the gate, same as /ingest/build.
const MID = /^\d{1,20}$/;
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
function cleanCmdr(v) {
  const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim();
  return /^[\w .'\-]{1,40}$/.test(s) ? s.slice(0, 40) : "";
}

async function applyOne(env, c, defaultVia) {
  const marketId = String(c.marketId || "").trim();
  if (!MID.test(marketId)) return "invalid";
  const owner = cleanCmdr(c.cmdr);
  if (!owner || owner.toLowerCase() === "unknown") return "invalid";
  const ts = Number(c.ts) || Date.now();

  const kvKey = "carrier:" + marketId;
  let existing = null;
  try { const v = await env.BUILDS.get(kvKey); if (v) existing = JSON.parse(v); } catch (e) {}
  // Stale event (backfill arriving after a newer live report) — keep what we have.
  if (existing && existing.ts && ts < existing.ts) return "kept";

  await env.BUILDS.put(kvKey, JSON.stringify({
    marketId,
    callsign: String(c.callsign || "").slice(0, 16),
    name: String(c.name || "").slice(0, 80),
    owner,
    ts,
    via: String(c.via || defaultVia || "live").slice(0, 20),
  }));

  // Reverse index: which carrier does this CMDR own? (one carrier per commander in ED.)
  const rk = "cmdrcarrier:" + owner.toLowerCase();
  let rev = null;
  try { const v = await env.BUILDS.get(rk); if (v) rev = JSON.parse(v); } catch (e) {}
  if (!(rev && rev.ts && ts < rev.ts)) {
    await env.BUILDS.put(rk, JSON.stringify({ marketId, ts }));
  }
  return "applied";
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  if (!env.INGEST_KEY || String(body.key || "") !== String(env.INGEST_KEY)) return json({ ok: false, error: "unauthorized" }, 401);

  const items = Array.isArray(body.carriers) ? body.carriers : [body];
  if (!items.length) return json({ ok: false, error: "no carriers" }, 400);
  if (items.length > 200) return json({ ok: false, error: "too many carriers (max 200 per POST)" }, 400);

  const out = { applied: 0, kept: 0, invalid: 0 };
  for (const c of items) out[await applyOne(env, c, body.via)]++;
  return json({ ok: true, ...out });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades carrier registry. POST { key, marketId, callsign, name, cmdr } or { key, carriers:[...] }." });
}
