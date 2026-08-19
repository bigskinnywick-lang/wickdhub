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
import { project, fieldsFor, unreadableFor, MANIFEST_VERSION, SCOPE_OWN, SCOPE_SQUAD_AGG } from "../../_lib/manifest.js";

const RAVEN = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net";
const RAVEN_TIMEOUT_MS = 6000;
// "Online" = a plugin heartbeat inside this window. Telemetry itself is kept for
// 6h, which is a retention period, not a liveness one — using the TTL as the
// window is how a counter quietly shrinks its own population.
const ONLINE_WINDOW_MS = 10 * 60 * 1000;

// ⚠ A read that FAILED and a key that is genuinely absent are different facts,
// and the first cut of this file could not tell them apart — both became null,
// both became an omitted field, and a consumer saw one silence for two causes.
// `bad` collects the fields whose source would not answer; they are reported in
// `unreadable[]` rather than emitted as a convincing empty.
async function kvJson(env, key, bad, field) {
  try {
    const v = await env.BUILDS.get(key);
    return v ? JSON.parse(v) : null;          // genuinely absent
  } catch (e) {
    if (bad && field) bad.add(field);         // could not look
    return null;
  }
}

/**
 * ★ 2026-08-18 — WHICH build the summary describes. Exported as pure functions so
 * the tests drive the REAL rule instead of a hand-written mirror of it; the last
 * time a gate was tested by copy, two of three mutations went undetected
 * (tests/navpull-intent.test.mjs has the full story).
 *
 * `wantedMarketId` reads the MOST RECENT intent row only. Older rows are a rolling
 * window of past trips, and answering from one of those is the same wrong-site bug
 * in a slower form.
 */
export function wantedMarketId(intent) {
  const rows = intent && Array.isArray(intent.recent) ? intent.recent : null;
  if (!rows || !rows.length) return 0;
  const n = Number(rows[0] && rows[0].marketId);
  return Number.isSafeInteger(n) && n > 0 ? n : 0;
}

/**
 * ⚠ THREE CASES, and the middle one is the whole point.
 *   pinned           -> describe the site he clicked.
 *   asked, no pin    -> he clicked a site this squad has no build record for.
 *                       Return "" and say NOTHING. Falling back here re-creates the
 *                       exact defect: a confident summary of a site he never asked
 *                       about. Could-not-pin is not nothing-there.
 *   never asked      -> no marketId recorded, so keep the pre-existing behaviour
 *                       rather than silently changing what today's callers get.
 *                       Still a guess; it is just no longer the only mode.
 */
export function pickBuildId(wantMarket, pinnedBuildId, firstOpenBuildId) {
  return wantMarket ? (pinnedBuildId || "") : (firstOpenBuildId || "");
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
  const bad = new Set();

  const tel = await kvJson(env, `plugin:telemetry:${cmdrLower}`, bad, "system");
  if (tel && tel.telemetry) {
    const t = tel.telemetry;
    Object.assign(bag, {
      system: t.sys, ship: t.ship, shipName: t.shipName, status: t.status,
      fuelPct: t.fuelPct, cargo: t.cargo, cargoCap: t.cargoCap, telemetryTs: tel.ts,
    });
  }

  const al = await kvJson(env, `plugin:alerts:${cmdrLower}`, bad, "alerts");
  if (al && Array.isArray(al.alerts)) bag.alerts = al.alerts;

  const cargoM = await kvJson(env, `sq:${SQ}:cargo:${cmdrLower}`, bad, "cargoManifest");
  if (cargoM && cargoM.items) bag.cargoManifest = cargoM.items;

  const intent = await kvJson(env, `sq:${SQ}:intent:${cmdrLower}`, bad, "intent");
  if (intent && Array.isArray(intent.recent)) bag.intent = intent.recent;

  const lo = await kvJson(env, `carrier:${(await kvJson(env, `cmdrcarrier:${cmdrLower}`) || {}).marketId || "none"}`);
  if (lo && String(lo.owner || "").toLowerCase() === cmdrLower) {
    bag.myCarrier = { marketId: lo.marketId, callsign: lo.callsign, name: lo.name };
  }

  // ── own claims + squad aggregates, one pass over the namespace ────────────
  let pilotsOnline = 0;
  const systems = new Set();
  const myClaims = [];
  // ★ 2026-08-18 — WHICH build the summary is about.
  //
  // This used to be "the first non-completed GUID key the scan happens to hit",
  // which answered with total confidence about a site the pilot may never have
  // clicked. Nothing was ever malformed, so nothing ever looked wrong — the same
  // shape as pilotsOnline counting browsers. Adam read one of those summaries as a
  // hallucination; it was more likely real tonnage for the wrong build.
  //
  // The intent row now carries the marketId of the site he actually clicked, so
  // pin on that. It costs one comparison inside a loop that already loads and
  // parses every build record — and once pinned we are standing on the GUID, so
  // the Raven call needs no id from the sidecar at all.
  const wantMarket = wantedMarketId(intent);
  let pinnedBuildId = "";
  let firstOpenBuildId = "";
  try {
    const list = await env.BUILDS.list();
    for (const k of list.keys) {
      const n = k.name;
      // NOT presence:* — that key is written by a signed-in BROWSER loading the
      // board, so it measures "who has the page open", not "who is flying". The
      // rig called this out: Adam was docked and telemetering with a live token
      // and the aggregate still said nobody was online.
      //
      // Count live plugin heartbeats instead. Deliberately INCLUDES the caller —
      // he is a pilot who is online, and excluding him is exactly the kind of
      // undocumented subtraction that makes a counter decorative.
      if (n.startsWith("plugin:telemetry:")) {
        const t = await kvJson(env, n, bad, "pilotsOnline");
        if (t && t.ts && (Date.now() - t.ts) < ONLINE_WINDOW_MS) pilotsOnline++;
        continue;
      }
      if (n.startsWith("presence:")) continue;
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
          if (!b.completedTs && !firstOpenBuildId) firstOpenBuildId = n;
          if (wantMarket && Number(b.marketId) === wantMarket) pinnedBuildId = n;
        }
      }
    }
  } catch (e) {}
  if (myClaims.length) bag.myClaims = myClaims;
  bag.pilotsOnline = pilotsOnline;
  bag.systemsActive = systems.size;

  const activeBuildId = pickBuildId(wantMarket, pinnedBuildId, firstOpenBuildId);
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
  let out = project(bag, scopes, [...bad]);

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
    // Named here rather than silently emitted as an empty container. "Could not
    // look" must never read as "nothing there" — least of all for alerts.
    unreadable: unreadableFor(scopes, [...bad]),
    data: out,
    ts: Date.now(),
  });
}
