// Cloudflare Pages Function — OWN observations the plugin used to throw away.
//
// POST /ingest/observe { kind: "requirements", marketId, commodities:{name:qty} }
// POST /ingest/observe { kind: "cargo",        items:{name:qty} }
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
// Three facts were being parsed out of the journal and binned. Adam's framing,
// and it is the right one: HOARD NOW, USE LATER. A fact you did not keep is not
// recoverable later, so record it at the moment it exists and build nothing on
// top of it yet.
//
//   • ResourcesRequired — the full per-commodity requirement list off every
//     ColonisationConstructionDepot. Parsed, cached in memory, then dropped
//     unless auto-create happened to fire. Meanwhile the board re-fetched the
//     identical numbers from RavenColonial. We were reading the game's own copy
//     and throwing it away.
//   • Cargo contents — the plugin only ever read `Count`, the total tonnage.
//     What was actually IN the hold was never looked at.
//
// (The third, which commodity was searched before plotting, cannot come from
// here — that intent only exists in the browser. It rides /blades/api/navpush.)
//
// ─── CLASSIFICATION ──────────────────────────────────────────────────────────
// Cargo is OWN — self only, TTL'd like the rest of the live cockpit state.
// Requirements are about a PLACE, not a pilot, so they are a squad aggregate:
// "this site still needs 1,200 titanium" names nobody.
// Both are declared in functions/_lib/manifest.js. Undeclared, they could not be
// read back out even if stored.
import { authIngest, json, SQ } from "../_lib/ingest-auth.js";

const CARGO_TTL_S = 60 * 60 * 6;   // same 6h as telemetry — live state, not a record
const MAX_ENTRIES = 200;           // a hold has ~40 slots; a site needs ~30 commodities
const MID = /^\d{1,20}$/;

// Commodity keys arrive as ED's bare symbol (the plugin already strips the
// $..._name; wrapper). Keep them boring: lowercase, alphanumeric + underscore.
function cleanTable(obj) {
  const out = {};
  if (!obj || typeof obj !== "object") return out;
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= MAX_ENTRIES) break;
    const key = String(k).toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
    const qty = Math.round(Number(v));
    if (!key || !isFinite(qty) || qty < 0) continue;
    out[key] = Math.min(qty, 100000000);
    n++;
  }
  return out;
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}

  const a = await authIngest(request, env, body, null);
  if (!a.ok) return json({ ok: false, error: a.error }, a.status);

  const kind = String(body.kind || "").toLowerCase();

  if (kind === "cargo") {
    const items = cleanTable(body.items);
    const rec = { items, ts: Number(body.ts) || Date.now(), cmdr: a.cmdr };
    try {
      await env.BUILDS.put(`sq:${SQ}:cargo:${a.cmdrLower}`, JSON.stringify(rec), { expirationTtl: CARGO_TTL_S });
    } catch (e) { return json({ ok: false, error: "write failed" }, 500); }
    return json({ ok: true, kind, count: Object.keys(items).length });
  }

  if (kind === "requirements") {
    const marketId = String(body.marketId == null ? "" : body.marketId).trim();
    if (!MID.test(marketId)) return json({ ok: false, error: "invalid marketId" }, 400);
    const commodities = cleanTable(body.commodities);
    if (!Object.keys(commodities).length) return json({ ok: true, kind, result: "empty" });

    const key = `sq:${SQ}:req:${marketId}`;
    const ts = Number(body.ts) || Date.now();
    // Newest wins, same rule as every other ingest route — a replayed or
    // backfilled observation must not clobber a fresher one.
    let existing = null;
    try { const v = await env.BUILDS.get(key); if (v) existing = JSON.parse(v); } catch (e) {}
    if (existing && existing.ts && ts < existing.ts) return json({ ok: true, kind, result: "kept" });

    try {
      await env.BUILDS.put(key, JSON.stringify({ commodities, ts, by: a.cmdr }));
    } catch (e) { return json({ ok: false, error: "write failed" }, 500); }
    return json({ ok: true, kind, marketId, count: Object.keys(commodities).length });
  }

  return json({ ok: false, error: "unknown kind" }, 400);
}

export async function onRequestGet() {
  return json({
    ok: true,
    note: "Blades observation intake. POST { kind:'cargo', items } or { kind:'requirements', marketId, commodities }. Hoarded for later; read back only through the manifest.",
  });
}
