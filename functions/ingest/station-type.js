// Cloudflare Pages Function — completed-station type/economy capture.
//
// Colonisation depot events never carry the chosen facility economy; the real
// StationType + StationEconomy only appear on a Docked/Location event once a site
// is built. The plugin reports those here so the board can show the EXACT facility
// type (and economy) for a completed build instead of the generic manifest label.
//
// POST /ingest/station-type
//   { key, marketId, stationType, economy?, economyLocalised?, stationName?, ts? }
//
// Storage: BUILDS KV "stationmeta:{marketId}" -> { stationType, economy, economyLocalised, stationName, ts }
// Newest ts wins. Non-GUID key => rides in export other{} (backed up).
// Public route (Access Bypass); INGEST_KEY is the gate, same as /ingest/build.
const MID = /^\d{1,20}$/;
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const clean = (v, n) => String(v || "").replace(/[\u0000-\u001f]/g, "").trim().slice(0, n || 60);

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  if (!env.INGEST_KEY || String(body.key || "") !== String(env.INGEST_KEY)) return json({ ok: false, error: "unauthorized" }, 401);
  const marketId = String(body.marketId == null ? "" : body.marketId).trim();
  if (!MID.test(marketId)) return json({ ok: false, error: "invalid marketId" }, 400);
  const stationType = clean(body.stationType, 40);
  if (!stationType || /ConstructionDepot$/i.test(stationType) || /^FleetCarrier$/i.test(stationType)) return json({ ok: true, result: "skipped" });
  const ts = Number(body.ts) || Date.now();
  const kvKey = "stationmeta:" + marketId;
  let existing = null;
  try { const v = await env.BUILDS.get(kvKey); if (v) existing = JSON.parse(v); } catch (e) {}
  if (existing && existing.ts && ts < existing.ts) return json({ ok: true, result: "kept" });
  const rec = { stationType, economy: clean(body.economy, 40), economyLocalised: clean(body.economyLocalised, 40), stationName: clean(body.stationName, 80), ts };
  try { await env.BUILDS.put(kvKey, JSON.stringify(rec)); } catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, marketId, stationType });
}
