// Cloudflare Pages Function — ingest endpoint for the Blades Registrar EDMC plugin.
//
// POST /ingest/build
//   { key, marketId, systemAddress, cmdr }              -> resolve existing build & register (default)
//   { key, marketId, systemAddress, cmdr, create:true,  -> if none exists, auto-create it in Raven,
//     architect, systemName, buildName, bodyName, bodyNum } then register
//   { key, id }                                          -> register a known buildId directly
//
// Validates the shared key, resolves the RavenColonial buildId from marketId+systemAddress,
// and upserts it into the same KV (BUILDS). Public route (Access Bypass) — the key is the gate.
//
// ARCHITECT ATTRIBUTION (claims-first, added 2026-07-21): auto-create resolves the
// architect as claims ledger ("claim:{systemAddress}" KV keys fed by /ingest/claim,
// exact) -> predominant sibling architectName in Raven ("raven-siblings", inferred)
// -> the plugin's fallback squad name ("fallback"). The KV build record carries
// architect + architectSource + verified so the board can badge unverified builds
// and reconcile them later.
const RAVEN = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net";
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
// A browser-ish UA for outbound Raven calls (harmless; avoids any UA-based filtering).
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// --- Raven helpers ----------------------------------------------------------
async function ravenGet(path) {
  try {
    const r = await fetch(RAVEN + path, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; }
}

// The project registered at a specific construction market, or null if none yet.
async function resolveProject(systemAddress, marketId) {
  return await ravenGet("/api/system/" + encodeURIComponent(systemAddress) + "/" + encodeURIComponent(marketId));
}

// FIRST-PARTY attribution: the squad claims ledger (see /ingest/claim).
// ColonisationSystemClaim only ever fires in the architect's own journal, so a
// ledger hit IS the architect — it outranks sibling inference and the fallback.
async function claimedArchitect(env, systemAddress) {
  try {
    const v = await env.BUILDS.get("claim:" + String(systemAddress));
    if (!v) return null;
    const c = JSON.parse(v);
    return c && c.architect ? c : null;
  } catch (e) { return null; }
}

// Best-effort "who is the architect of this system?" — one architect claims a whole
// system and builds several sites, so any sibling build in the same system reveals them.
// Returns the most common non-empty architectName across the system's known builds,
// or "" when the system has no prior Raven record.
async function resolveSiblingArchitect(systemAddress) {
  const sys = await ravenGet("/api/system/" + encodeURIComponent(systemAddress));
  const list = Array.isArray(sys) ? sys : (sys && Array.isArray(sys.builds) ? sys.builds : []);
  const tally = {};
  for (const b of list) {
    const a = (b && b.architectName ? String(b.architectName) : "").trim();
    if (a) tally[a] = (tally[a] || 0) + 1;
  }
  let best = "", bestN = 0;
  for (const a in tally) { if (tally[a] > bestN) { best = a; bestN = tally[a]; } }
  return best;
}

// Create a project via PUT /api/project/ (the same call Raven's own web app uses).
// We deliberately pass marketId + systemAddress (which we know for certain) rather than
// the /api/project/from/{sysAddr}/{siteId} route, whose 2nd segment is a Raven site id,
// not the game MarketID. buildType is left blank: the correct commodity template gets set
// by the architect in Raven, and live per-delivery quantities flow in via the Raven plugin.
async function createProject(body) {
  try {
    const r = await fetch(RAVEN + "/api/project/", {
      method: "PUT",
      headers: { "User-Agent": UA, "Accept": "application/json", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: r.status, ok: r.ok, data: await r.json().catch(() => null) };
  } catch (e) {
    return { status: 0, ok: false, data: null, err: String(e) };
  }
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let body = {};
  try { body = await request.json(); } catch (e) {}
  if (!env.INGEST_KEY || String(body.key || "") !== String(env.INGEST_KEY)) return json({ ok: false, error: "unauthorized" }, 401);

  const cmdr = String(body.cmdr || "plugin");
  let id = String(body.id || "").toLowerCase().trim();
  let name = "", system = "", createdArchitect = "";

  // 1) Resolve an existing build for this construction market.
  let proj = null;
  if (!GUID.test(id) && body.marketId && body.systemAddress) {
    proj = await resolveProject(body.systemAddress, body.marketId);
    if (proj && proj.buildId) { id = String(proj.buildId).toLowerCase(); name = proj.buildName || ""; system = proj.systemName || ""; }
  }

  // 2) None exists. Either wait (default) or auto-create when the plugin asks (safeguarded there).
  if (!GUID.test(id)) {
    if (!(body.create && body.marketId && body.systemAddress)) {
      return json({ ok: false, error: "no build for that market yet" }, 404);
    }
    // Attribution resolution: claims ledger (exact) -> Raven siblings (inferred) -> fallback.
    let architect = "", architectSource = "";
    const claim = await claimedArchitect(env, body.systemAddress);
    if (claim) {
      architect = claim.architect; architectSource = "claim";
    } else {
      const sib = await resolveSiblingArchitect(body.systemAddress);
      if (sib) { architect = sib; architectSource = "raven-siblings"; }
      else { architect = String(body.architect || "Onyx Blades"); architectSource = "fallback"; }
    }
    const newProject = {
      buildName: String(body.buildName || body.systemName || "New construction").slice(0, 120),
      buildType: "",
      marketId: body.marketId,
      systemAddress: body.systemAddress,
      systemName: body.systemName || (proj && proj.systemName) || "",
      architectName: architect,
      bodyName: body.bodyName || "",
      bodyNum: (typeof body.bodyNum === "number" ? body.bodyNum : null),
      isPrimaryPort: false,
      prepBuilds: {},
    };
    const res = await createProject(newProject);
    // Whatever the response shape, re-resolve authoritatively from Raven for the buildId.
    let created = (res.data && res.data.buildId) ? res.data : await resolveProject(body.systemAddress, body.marketId);
    if (!created || !created.buildId) {
      const reason = res.status === 401 || res.status === 403 ? "raven_auth"
        : res.status === 409 ? "conflict"
        : ("raven_" + (res.status || "error"));
      return json({ ok: false, error: "create_failed", reason, status: res.status || 0 }, 502);
    }
    id = String(created.buildId).toLowerCase();
    name = created.buildName || newProject.buildName;
    system = created.systemName || newProject.systemName;
    createdArchitect = created.architectName || architect;

    const existed = await env.BUILDS.get(id);
    const meta = {
      name, system, architect: createdArchitect, architectSource,
      verified: architectSource !== "fallback",
      addedBy: cmdr, ts: Date.now(), marketId: body.marketId || null, via: "registrar-auto",
    };
    await env.BUILDS.put(id, JSON.stringify(meta));
    return json({ ok: true, id, added: !existed, created: true, name, system, architect: createdArchitect, architectSource });
  }

  // 3) We have a buildId — register it if new. Attribution: Raven's own record is
  // authoritative for existing builds (the architect set it); claims ledger as backup.
  const existing = await env.BUILDS.get(id);
  if (existing) return json({ ok: true, id, added: false });
  let architect = (proj && proj.architectName ? String(proj.architectName).trim() : "");
  if (!name) {
    const p = await ravenGet("/api/project/" + id);
    if (p) { name = p.buildName || ""; system = p.systemName || ""; architect = architect || (p.architectName ? String(p.architectName).trim() : ""); }
  }
  let architectSource = architect ? "raven" : "";
  if (!architect && body.systemAddress) {
    const claim = await claimedArchitect(env, body.systemAddress);
    if (claim) { architect = claim.architect; architectSource = "claim"; }
  }
  const meta = {
    name, system, architect, architectSource, verified: !!architect,
    addedBy: cmdr, ts: Date.now(), marketId: body.marketId || null, via: "registrar",
  };
  await env.BUILDS.put(id, JSON.stringify(meta));
  return json({ ok: true, id, added: true, name, system, architect, architectSource });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades Registrar ingest endpoint. POST { key, marketId, systemAddress, cmdr[, create, architect] }." });
}
