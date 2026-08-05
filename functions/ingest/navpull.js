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
  for (const k of ["autocreate", "honk"]) if (typeof s[k] === "boolean") out[k] = s[k];
  return Object.keys(out).length ? out : null;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (!env.INGEST_KEY || key !== String(env.INGEST_KEY)) return json({ ok: false, error: "unauthorized" }, 401);
  const cmdr = cleanCmdr(url.searchParams.get("cmdr"));
  if (!cmdr) return json({ ok: false, error: "cmdr required" }, 400);
  const cmdrLower = cmdr.toLowerCase();

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

  return json({ ok: true, system: navSystem, ts: navTs, latest, channel, settings });
}
