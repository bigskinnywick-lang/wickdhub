// Cloudflare Pages Function — squad ship + cargo registry for the Blades Registrar plugin.
//
// The plugin reports a commander's CURRENT ship and cargo hold (from the game's
// Loadout + Cargo journal events) so the boards can show, per member, what everyone
// is flying and how much they can haul — which makes the load/trip maths on a build
// actually mean something. Live, self-expiring, no manual roster.
//
// POST /ingest/loadout
//   { key, cmdr, ship?, shipName?, cargoCap, cargoUsed?, ts? }
//
// Storage: same BUILDS KV namespace.
//   "loadout:{cmdrLower}" -> { cmdr, ship, shipName, cargoCap, cargoUsed, ts }
// Non-GUID key => rides in export other{} (backed up). Newest ts wins so a stale
// event can't clobber a fresher one. Public route (Access Bypass); the key is the
// gate, same as /ingest/build and /ingest/carrier.
//
// AUTH 2026-08-16: commander is now DERIVED from a per-device token where one is
// presented, and only falls back to body.cmdr + the shared key during migration.
// See functions/_lib/ingest-auth.js.
import { authIngest } from "../_lib/ingest-auth.js";

const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
function cleanCmdr(v) {
  const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim();
  return /^[\w .'\-]{1,40}$/.test(s) ? s.slice(0, 40) : "";
}
const clampInt = (v, max) => {
  const n = Math.round(Number(v));
  if (!isFinite(n) || n < 0) return 0;
  return Math.min(n, max);
};

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  const a = await authIngest(request, env, body, null);
  if (!a.ok) return json({ ok: false, error: a.error }, a.status);

  const cmdr = a.cmdr;
  const ts = Number(body.ts) || Date.now();

  const kvKey = "loadout:" + a.cmdrLower;
  let existing = null;
  try { const v = await env.BUILDS.get(kvKey); if (v) existing = JSON.parse(v); } catch (e) {}
  if (existing && existing.ts && ts < existing.ts) return json({ ok: true, result: "kept" });

  const rec = {
    cmdr,
    ship: String(body.ship || "").slice(0, 40),            // raw ED ship type; board maps to friendly
    shipName: String(body.shipName || "").slice(0, 40),    // player-given ship name
    cargoCap: clampInt(body.cargoCap, 2000),
    cargoUsed: clampInt(body.cargoUsed, 2000),
    ts,
  };
  if (rec.cargoUsed > rec.cargoCap && rec.cargoCap > 0) rec.cargoUsed = rec.cargoCap;
  try { await env.BUILDS.put(kvKey, JSON.stringify(rec)); } catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, result: "applied", cmdr });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades ship/cargo registry. POST { key, cmdr, ship, shipName, cargoCap, cargoUsed }." });
}
