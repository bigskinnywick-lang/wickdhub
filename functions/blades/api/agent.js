// Cloudflare Pages Function — THE AGENT READ API.
//
// GET /blades/api/agent            -> everything this token's scopes allow
// GET /blades/api/agent?fields=a,b -> just those, still manifest-filtered
//
// ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
// Until now Blades had NO read path for a non-browser client. Every /blades/api/*
// route is gated by a Cloudflare Access session COOKIE; every /ingest/* route is
// a shared-secret WRITE. So the rig-side assistant could not read the board —
// not "unwired", there was no shape for it.
//
// This is that shape. Authenticated by the same per-device token the Registrar
// uses, so an agent running beside the plugin on the pilot's own machine reads
// with the pilot's own credential and nothing new had to be invented.
//
// ─── THE RULE ────────────────────────────────────────────────────────────────
// An agent may answer about the pilot holding the token, and aggregates about
// everyone else. "Where is CMDR X" stays closed at every permission level.
//
// ─── WHY THE MANIFEST IS IMPORTED RATHER THAN REIMPLEMENTED ──────────────────
// Every field returned here is copied out by `project()`, which iterates the
// MANIFEST and pulls — it never iterates the data and filters. A filter forgets
// a new field; a whitelist cannot. So adding something to this response is
// impossible without a manifest row stating its class and its sharing decision,
// which is a reviewable diff rather than a thing someone has to remember.
//
// ⚠ If you find yourself wanting to `out.something = ...` below, stop. Add the
// manifest row instead. That reflex IS the control.
import { authIngest, json, SQ } from "../../_lib/ingest-auth.js";
import { project, fieldsFor, MANIFEST_VERSION, SCOPE_OWN, SCOPE_SQUAD_AGG } from "../../_lib/manifest.js";

const RAVEN = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net";
const RAVEN_TIMEOUT_MS = 6000;

async function kvJson(env, key) {
  try { const v = await env.BUILDS.get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}

async function ravenProject(buildId) {
  if (!buildId) return null;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), RAVEN_TIMEOUT_MS);
  try {
    const r = await fetch(`${RAVEN}/api/project/${encodeURIComponent(buildId)}`, { signal: c.signal });
    return r.ok ? await r.json() : null;
  } catch (e) { return null; } finally { clearTimeout(t); }
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const url = new URL(request.url);

  // Same credential as the ingest side. requireCmdr:false so the error we return
  // is about the token, not about a missing query param.
  const a = await authIngest(request, env, null, url, { requireCmdr: false });
  if (!a.ok) return json({ ok: false, error: a.error }, a.status);
  if (a.via !== "device") {
    // The shared key is one string every pilot holds — it cannot say WHO is
    // asking, and a read API that cannot identify its caller is not one.
    return json({ ok: false, error: "agent read requires a paired device token, not the shared key" }, 403);
  }

  const cmdr = a.cmdr;
  const cmdrLower = a.cmdrLower;
  const scopes = [SCOPE_OWN, SCOPE_SQUAD_AGG];

  // ── gather ────────────────────────────────────────────────────────────────
  // Assembled into a flat bag first, then projected. The bag may legitimately
  // hold more than the caller is allowed — project() is what decides.
  const bag = {};

  const tel = await kvJson(env, `plugin:telemetry:${cmdrLower}`);
  if (tel && tel.telemetry) {
    const t = tel.telemetry;
    Object.assign(bag, {
      system: t.sys, ship: t.ship, shipName: t.shipName, status: t.status,
      fuelPct: t.fuelPct, cargo: t.cargo, cargoCap: t.cargoCap, telemetryTs: tel.ts,
    });
  }

  const al = await kvJson(env, `plugin:alerts:${cmdrLower}`);
  if (al && Array.isArray(al.alerts)) bag.alerts = al.alerts;

  const cargoM = await kvJson(env, `sq:${SQ}:cargo:${cmdrLower}`);
  if (cargoM && cargoM.items) bag.cargoManifest = cargoM.items;

  const intent = await kvJson(env, `sq:${SQ}:intent:${cmdrLower}`);
  if (intent && Array.isArray(intent.recent)) bag.intent = intent.recent;

  const lo = await kvJson(env, `carrier:${(await kvJson(env, `cmdrcarrier:${cmdrLower}`) || {}).marketId || "none"}`);
  if (lo && String(lo.owner || "").toLowerCase() === cmdrLower) {
    bag.myCarrier = { marketId: lo.marketId, callsign: lo.callsign, name: lo.name };
  }

  // ── own claims + squad aggregates, one pass over the namespace ────────────
  let pilotsOnline = 0;
  const systems = new Set();
  const myClaims = [];
  let activeBuildId = "";
  try {
    const list = await env.BUILDS.list();
    for (const k of list.keys) {
      const n = k.name;
      if (n.startsWith("presence:")) { pilotsOnline++; continue; }
      if (n.startsWith("claim:")) {
        const c = await kvJson(env, n);
        if (c && String(c.architect || "").toLowerCase() === cmdrLower) {
          myClaims.push({ systemAddress: n.slice("claim:".length), system: c.system, ts: c.ts, primaryDone: !!c.primaryDone });
        }
        continue;
      }
      // builds are bare GUID keys
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(n)) {
        const b = await kvJson(env, n);
        if (b) {
          if (b.system) systems.add(b.system);
          if (!b.completedTs && !activeBuildId) activeBuildId = n;
        }
      }
    }
  } catch (e) {}
  if (myClaims.length) bag.myClaims = myClaims;
  bag.pilotsOnline = pilotsOnline;
  bag.systemsActive = systems.size;

  const proj = await ravenProject(activeBuildId);
  if (proj) {
    const need = Number(proj.sumNeed) || 0;
    bag.buildProgress = {
      buildId: activeBuildId,
      buildName: proj.buildName || "",
      system: proj.systemName || "",
      remaining: need,
      complete: !!proj.complete,
    };
    // Requirements are about a PLACE, not a pilot — squad aggregate.
    const req = await kvJson(env, `sq:${SQ}:req:${proj.marketId || ""}`);
    if (req && req.commodities) bag.siteRequirements = req.commodities;
  }

  // ── project ───────────────────────────────────────────────────────────────
  let out = project(bag, scopes);

  // Optional narrowing, purely a convenience for the caller. It can only ever
  // REMOVE from an already-projected object — asking for a field you are not
  // entitled to gets you nothing, not an error, because the entitlement was
  // already decided above.
  const want = (url.searchParams.get("fields") || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (want.length) {
    const narrowed = {};
    for (const w of want) if (Object.prototype.hasOwnProperty.call(out, w)) narrowed[w] = out[w];
    out = narrowed;
  }

  return json({
    ok: true,
    manifest: MANIFEST_VERSION,
    cmdr,                       // whose data this is — derived from the credential
    scopes,
    available: fieldsFor(scopes).map((m) => m.key),
    data: out,
    ts: Date.now(),
  });
}
