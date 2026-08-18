// Cloudflare Pages Function — the plugin's read side of "nav push" + the plugin's
// version heartbeat / auto-update channel + per-pilot Companion settings.
//
// The Blades Registrar plugin (on a commander's PC) polls this on its own timer.
// It does four things in one call:
//   1) returns that commander's latest galaxy-map nav target (pushed from the board
//      via /blades/api/navpush) to drop on the PC clipboard;
//   2) records the plugin's reported running (+ staged) version as a heartbeat, so
//      the board knows who is up to date  (KV "cmdrver:{cmdr}");
//   3) returns the release the plugin SHOULD be on ("latest"), chosen per-pilot by
//      the pilot's own test-track SWITCH (KV "plugin:tier"): armed -> beta build,
//      disarmed -> stable;
//   4) returns that commander's Companion settings (KV "plugin:settings"), set from
//      the MY STATS panel — auto-create + assist features (honk, ...). The plugin
//      applies them live, no EDMC restart.
//
// Plugin-authed with INGEST_KEY (same as the other /ingest/* endpoints); the caller
// passes ?cmdr= and optionally ?v=<running>&pending=<staged>. No caching.
//
// GET /ingest/navpull?key=..&cmdr=Name[&v=1.9][&pending=2.0]
//   -> { ok, system, ts, latest:{version,sha256,notes,url}|null, channel, settings:{autocreate,honk}|null }
import { authIngest } from "../_lib/ingest-auth.js";

const HEARTBEAT_TTL_S = 60 * 60 * 24 * 14; // 14 days — a pilot who stops flying drops off
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
function cleanCmdr(v) {
  const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim();
  return /^[\w .'\-]{1,40}$/.test(s) ? s.slice(0, 40) : "";
}
// Version string filter — safe charset only. Pure-numeric dotted = stable (e.g.
// "2.1"); anything containing a letter = beta, position-agnostic ("b2.1", "2.1B",
// "2.1-beta"). Routing by that rule happens at release-cut time, not here.
function cleanVer(v) {
  const s = String(v || "").trim();
  return /^[A-Za-z0-9.\-]{1,20}$/.test(s) ? s : "";
}

async function readJson(env, key) {
  try { const v = await env.BUILDS.get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; }
}
// The pilot's CHANNEL is driven by their own switch (KV "plugin:tier"), NOT by any role
// or admin action. The test-pilot role only decides whether the board offers the switch;
// once offered, the pilot alone arms/disarms the beta track and the plugin follows. A
// member can never have a non-retail tier written (/blades/api/testpilot validates
// clearance before storing), so reading the tier straight through is safe: retail (or no
// entry) -> stable; beta/research -> the beta build.
async function tierChannel(env, cmdrLower) {
  const m = await readJson(env, "plugin:tier");
  const t = (m && m[cmdrLower]) ? String(m[cmdrLower]).toLowerCase() : "retail";
  return t !== "retail" ? "beta" : "stable";
}
// Public shape of a release manifest — never leak internal ts/by.
function pubRelease(r) {
  if (!r || !r.version) return null;
  return { version: String(r.version), sha256: r.sha256 || "", notes: r.notes || "", url: r.url || "" };
}
async function latestFor(env, channel) {
  const stable = await readJson(env, "plugin:release:stable");
  if (channel === "beta") {
    const beta = await readJson(env, "plugin:release:beta");
    return pubRelease(beta) || pubRelease(stable); // beta pilots fall back to stable if no beta cut yet
  }
  return pubRelease(stable);
}
// This pilot's Companion settings, normalised to booleans (missing = null so the
// plugin keeps its own fallback rather than being forced off).
async function settingsFor(env, cmdrLower) {
  const m = await readJson(env, "plugin:settings");
  const s = (m && m[cmdrLower]) ? m[cmdrLower] : null;
  if (!s || typeof s !== "object") return null;
  const out = {};
  // ⚠⚠ THIS LIST IS DUPLICATED in functions/blades/api/plugin-settings.js (ALLOWED).
  // Adding a setting THERE without adding it HERE lets the board save it and the plugin
  // never receive it — the setting looks enabled in the UI and is dead in the plugin, with
  // no error anywhere. That is exactly what happened to `refocus` on 2026-08-10: the whole
  // feature was judged "broken on Windows" when it had simply never been switched on.
  // KEEP THE TWO LISTS IN LOCKSTEP.
  for (const k of ["autocreate", "honk", "galaxymap", "fuel", "pirate", "refocus", "refocusact"]) if (typeof s[k] === "boolean") out[k] = s[k];
  return Object.keys(out).length ? out : null;
}

// The plugin reports per-assist READINESS on its heartbeat (?ready=<url-encoded JSON>):
// which key-pressing assists have the keyboard binds they need, and — when they don't —
// the human list of what to set. This feeds the MY DASHBOARD / Companion readiness LEDs
// (red + "set this key"). Only assists that actually press an in-game control report here;
// everything else is implicitly ready. Kept on ONE key per pilot so a new assist is just a
// new sub-object, never a new endpoint.
const READY_ASSISTS = ["honk", "galaxymap"];
const READINESS_TTL_S = 60 * 60 * 24 * 14; // mirror the heartbeat: a pilot who stops flying ages out
function normReadiness(raw) {
  // Accept the compact plugin shape { honk:{r:0|1, m:[...]}, ... } and normalise to a
  // stable, bounded public shape. Unknown assists dropped; strings capped so a bad or
  // hostile payload can't bloat KV. Returns {} when there's nothing usable.
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch (e) { return {}; } }
  if (!obj || typeof obj !== "object") return {};
  const out = {};
  for (const k of READY_ASSISTS) {
    const v = obj[k];
    if (!v || typeof v !== "object") continue;
    const ready = (v.r === 1 || v.r === true || v.ready === true);
    const miss = Array.isArray(v.m) ? v.m : (Array.isArray(v.missing) ? v.missing : []);
    const missing = miss.filter(x => typeof x === "string").slice(0, 6).map(x => x.slice(0, 80));
    out[k] = { ready, missing: ready ? [] : missing };
  }
  return out;
}
function sameReadiness(a, b) {
  return JSON.stringify(a || {}) === JSON.stringify(b || {});
}
async function storeReadiness(env, cmdrLower, rawParam) {
  if (rawParam == null || rawParam === "") return;      // nothing reported this poll — keep last known
  if (rawParam.length > 1200) return;                    // guard: ignore absurdly large payloads
  const next = normReadiness(rawParam);
  if (!Object.keys(next).length) return;
  const prev = await readJson(env, "plugin:readiness:" + cmdrLower);
  // Dedup: the plugin only sends on change, but double-guard so a steady state never
  // rewrites KV every 5s.
  if (prev && sameReadiness(prev.assists, next)) return;
  try {
    await env.BUILDS.put("plugin:readiness:" + cmdrLower,
      JSON.stringify({ assists: next, ts: Date.now() }),
      { expirationTtl: READINESS_TTL_S });
  } catch (e) {}
}

// Live telemetry the plugin reports on its heartbeat (?tel=<url-encoded JSON>): the pilot's
// current system, ship, fuel %, cargo, flight state. Feeds the MY DASHBOARD tile row. Stored
// at KV plugin:telemetry:{cmdr} with a short TTL so a pilot who logs off goes "offline" (grey
// tiles) rather than showing a stale position forever.
const TELEMETRY_TTL_S = 60 * 60 * 6; // 6h — telemetry is live data, not a durable record
function normTelemetry(raw) {
  let obj = raw;
  if (typeof raw === "string") { try { obj = JSON.parse(raw); } catch (e) { return null; } }
  if (!obj || typeof obj !== "object") return null;
  const out = {};
  const str = (v, n) => (typeof v === "string" && v.trim()) ? v.trim().slice(0, n) : undefined;
  const intIn = (v, lo, hi) => {
    const n = Math.round(Number(v));
    return (Number.isFinite(n)) ? Math.max(lo, Math.min(hi, n)) : undefined;
  };
  const sys = str(obj.sys, 64); if (sys !== undefined) out.sys = sys;
  const ship = str(obj.ship, 32); if (ship !== undefined) out.ship = ship;
  const shipName = str(obj.shipName, 48); if (shipName !== undefined) out.shipName = shipName;
  const status = str(obj.status, 24); if (status !== undefined) out.status = status;
  const fuelPct = intIn(obj.fuelPct, 0, 100); if (fuelPct !== undefined) out.fuelPct = fuelPct;
  const cargo = intIn(obj.cargo, 0, 100000); if (cargo !== undefined) out.cargo = cargo;
  const cargoCap = intIn(obj.cargoCap, 0, 100000); if (cargoCap !== undefined) out.cargoCap = cargoCap;
  // b3.23 refocus outcome. rfAt is an epoch-ms stamp from the RIG's clock, so it gets its own
  // wide bound rather than riding intIn's 100000 cap, which would silently clamp it to a
  // constant and make every refocus look like the same one.
  const rfAt = Number(obj.rfAt);
  if (Number.isFinite(rfAt) && rfAt > 0) out.rfAt = Math.round(rfAt);
  const rfRung = str(obj.rfRung, 16); if (rfRung !== undefined) out.rfRung = rfRung;
  return Object.keys(out).length ? out : null;
}
async function storeTelemetry(env, cmdrLower, rawParam) {
  if (rawParam == null || rawParam === "") return;      // nothing reported — keep last known
  if (rawParam.length > 600) return;                     // guard
  const next = normTelemetry(rawParam);
  if (!next) return;
  try {
    await env.BUILDS.put("plugin:telemetry:" + cmdrLower,
      JSON.stringify({ telemetry: next, ts: Date.now() }),
      { expirationTtl: TELEMETRY_TTL_S });
  } catch (e) {}
}

// ALERTS the plugin raised (?al=<url-encoded JSON array>): the shared alert lane — pirate
// scan, fuel low, and whatever a future assist raises. Compact on the wire ({i,l,m,t}) and
// expanded here to the readable shape the dashboard strip renders. Merged into a per-pilot
// rolling log at KV plugin:alerts:{cmdr}, DEDUPED BY ID so a resend after a failed poll can
// never make the board sound the klaxon twice for one event.
const ALERTS_TTL_S = 60 * 60 * 6;  // 6h — an alert log is live context, not a durable record
const ALERTS_KEEP = 20;            // rolling window the strip reads from
const ALERT_LEVELS = { critical: 1, warn: 1, info: 1 };
function normAlerts(raw) {
  let arr = raw;
  if (typeof raw === "string") { try { arr = JSON.parse(raw); } catch (e) { return []; } }
  if (!Array.isArray(arr)) return [];
  const out = [];
  for (const a of arr.slice(0, 12)) {
    if (!a || typeof a !== "object") continue;
    const id = (typeof a.i === "string" || typeof a.i === "number") ? String(a.i).slice(0, 40) : "";
    const msg = (typeof a.m === "string") ? a.m.trim().slice(0, 120) : "";
    if (!id || !msg) continue;
    const lvlRaw = String(a.l || "info").toLowerCase();
    const level = ALERT_LEVELS[lvlRaw] ? lvlRaw : "info";
    const ts = Number(a.t);
    out.push({ id, level, msg, ts: Number.isFinite(ts) ? ts : Date.now() });
  }
  return out;
}
async function storeAlerts(env, cmdrLower, rawParam) {
  if (rawParam == null || rawParam === "") return;   // nothing raised this poll
  if (rawParam.length > 1600) return;                // guard against an absurd payload
  const next = normAlerts(rawParam);
  if (!next.length) return;
  const key = "plugin:alerts:" + cmdrLower;
  const prev = await readJson(env, key);
  const have = Array.isArray(prev && prev.alerts) ? prev.alerts : [];
  const seen = new Set(have.map(a => a && a.id));
  const fresh = next.filter(a => !seen.has(a.id));
  if (!fresh.length) return;                         // pure resend — do not rewrite KV
  const merged = have.concat(fresh).sort((a, b) => (a.ts || 0) - (b.ts || 0)).slice(-ALERTS_KEEP);
  try {
    await env.BUILDS.put(key, JSON.stringify({ alerts: merged, ts: Date.now() }),
      { expirationTtl: ALERTS_TTL_S });
  } catch (e) {}
}

/**
 * THE INTENT GATE — exported as a pure function ON PURPOSE.
 *
 * ⚠ The first version of this lived inline in the handler, and the test that
 * "proved" it was a hand-written mirror of the same logic. Mutating the real code
 * left the test green, because the test was checking its own copy. Two of three
 * mutations sailed through, including "emit an empty station as a value" — the
 * exact bug this gate exists to prevent. A control that cannot see the code it
 * guards is decoration, which is the same lesson as the manifest projector.
 *
 * Returns { intent, recorded } for a paired device, or null for anyone else.
 *
 * ★★ WHY THE GATE. This route also accepts the LEGACY shared key, a literal in
 * load.py in a PUBLIC repo — anyone can call `?key=&cmdr=` for any commander they
 * can name. It already leaks a nav target, channel and settings. Intent would add
 * what he is hauling and where he is taking it, which in this game is a pirate's
 * shopping list. No credential is exposed either way; the harm is that a public key
 * would start answering a materially more useful question. A legacy caller must
 * therefore get the pre-2026-08-17 payload byte for byte.
 *
 * ⚠ MATCHED ON `ts`, NOT ON SYSTEM. navpush writes the nav record and the intent row
 * in one request with the same timestamp. Matching on system would pick the wrong row
 * the second time one system is plotted for two commodities — and would look correct
 * every time it had only been done once.
 */
export function intentPayload(via, navSystem, navTs, recentRows) {
  if (via !== "device") return null;
  const recorded = navSystem ? ["system"] : [];
  const intent = {};
  if (navSystem && navTs) {
    const hit = Array.isArray(recentRows) ? recentRows.find((r) => r && r.ts === navTs) : null;
    if (hit) {
      // ★ ONE MEANING PER SILENCE. A name appears in `recorded` only when the field
      // actually holds a value. `station:""` was a real state in KV for a day after the
      // board silently dropped it, so a consumer must never read an empty string as
      // "this place has no station" — absence from `recorded` means NOT RECORDED.
      if (hit.commodity) { intent.commodity = hit.commodity; recorded.push("commodity"); }
      if (hit.station) { intent.station = hit.station; recorded.push("station"); }
    }
  }
  return { intent, recorded };
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const url = new URL(request.url);
  // AUTH 2026-08-16 — see functions/_lib/ingest-auth.js.
  // ⚠ This route is BOTH the auth-gated heartbeat AND the only channel through
  // which a plugin learns a new version exists. That is exactly why the shared
  // key cannot simply be rotated: kill it here and every deployed plugin goes
  // silent and can never be told about the fix. Dual-accept, migrate, then retire.
  const a = await authIngest(request, env, null, url);
  if (!a.ok) return json({ ok: false, error: a.error }, a.status);
  const cmdr = a.cmdr;
  const cmdrLower = a.cmdrLower;

  // (2) heartbeat — record reported running/staged version if the plugin sent it
  const running = cleanVer(url.searchParams.get("v"));
  const pending = cleanVer(url.searchParams.get("pending"));
  if (running) {
    try {
      await env.BUILDS.put("cmdrver:" + cmdrLower,
        JSON.stringify({ running, pending: pending || "", ts: Date.now() }),
        { expirationTtl: HEARTBEAT_TTL_S });
    } catch (e) {}
  }

  // (2b) per-assist readiness heartbeat — only written when the plugin sent it AND it changed
  await storeReadiness(env, cmdrLower, url.searchParams.get("ready"));

  // (2c) live telemetry heartbeat — only written when the plugin sent it (plugin sends on change)
  await storeTelemetry(env, cmdrLower, url.searchParams.get("tel"));

  // (2d) alerts the plugin raised — merged into the rolling per-pilot log, deduped by id
  await storeAlerts(env, cmdrLower, url.searchParams.get("al"));

  // (3) which release this pilot should be on — decided by the pilot's own switch
  const channel = await tierChannel(env, cmdrLower);
  const latest = await latestFor(env, channel);

  // (4) this pilot's Companion settings (from the MY STATS panel)
  const settings = await settingsFor(env, cmdrLower);

  // (1) nav target
  let rec = null;
  try { const v = await env.BUILDS.get("nav:" + cmdrLower); if (v) rec = JSON.parse(v); } catch (e) {}
  const navSystem = (rec && rec.system) ? rec.system : null;
  const navTs = (rec && rec.ts) ? rec.ts : 0;

  // b3.22 — the generic activation lane (functions/blades/api/act.js). Read-only here and
  // NOT deleted after reading: the plugin dedups by ts and rejects anything stale, so a
  // delete would only add a KV write per poll. The 60s TTL is the cleanup.
  let act = null;
  try {
    const a = await env.BUILDS.get("act:" + cmdrLower);
    if (a) { const o2 = JSON.parse(a); if (o2 && o2.ts) act = { kind: String(o2.kind || "button").slice(0, 24), ts: o2.ts }; }
  } catch (e) {}

  // ── (5) 2026-08-17: the INTENT sidecar, for COVAS ────────────────────────
  // The board records {system, commodity, station} at the moment the pilot clicks a
  // supplier row. This hands it to the rig alongside the nav target so COVAS can
  // decide between a system plot and the fuller station sequence.
  //
  // ★★ GATED ON `via === "device"`, AND THAT IS NOT A STYLE CHOICE.
  // This route also accepts the LEGACY shared key, which is a literal in load.py in a
  // PUBLIC repo — anyone can fetch it and call `?key=&cmdr=` for any commander they can
  // name. Today that leaks a nav target, channel and settings. Intent would add WHAT HE
  // IS HAULING AND WHERE HE IS TAKING IT, for a named CMDR — which in this game is
  // precisely a pirate's shopping list. No credential is exposed either way; the harm is
  // that a public key would start answering a materially more useful question.
  //
  // So a legacy caller gets the pre-2026-08-17 payload byte for byte, and only a paired
  // device sees intent. This ships the feature WITHOUT waiting on INGEST_LEGACY_OFF=1.
  //
  // ⚠ MATCHED ON `ts`, NOT ON SYSTEM. navpush writes the nav record and the intent entry
  // in one request with the same timestamp, so ts is exact. Matching on system instead
  // would pick the wrong row the second time he plots one system for two commodities —
  // and it would look right every time he only did it once.
  let sidecar = null;
  if (a.via === "device" && navSystem) {
    let rows = null;
    try {
      const iv = await env.BUILDS.get("sq:onyx:intent:" + cmdrLower);
      if (iv) { const io = JSON.parse(iv); if (Array.isArray(io.recent)) rows = io.recent; }
    } catch (e) { /* intent is additive; never fail the nav pull over it */ }
    sidecar = intentPayload(a.via, navSystem, navTs, rows);
  }

  // ★ `now` is the WORKER'S clock, returned so the plugin can age a nav push without ever
  // involving the rig's clock (b3.21 refocus freshness gate). Comparing a Cloudflare ts
  // against local time would turn that gate into a clock-skew detector. Cheap and additive:
  // an older plugin ignores the field, a newer plugin that does not get it fails closed.
  const out = { ok: true, system: navSystem, ts: navTs, now: Date.now(), act, latest, channel, settings };
  if (sidecar) { out.intent = sidecar.intent; out.recorded = sidecar.recorded; }
  return json(out);
}
