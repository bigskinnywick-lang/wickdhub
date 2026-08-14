// Cloudflare Pages Function — browser-facing carrier deck for the commander page.
//
// GET  /blades/api/carrier                  -> { me, cmdr, bound, carrier }   (the caller's own carrier)
// POST /blades/api/carrier  { action:"link", buildId }
//                                           -> server-side relay: link the caller's carrier to a build
//                                              in RavenColonial, then the board's existing Linked-Carriers
//                                              panel renders it.
//
// Identity: Access JWT -> email -> "cmdrlink:{email}" -> CMDR -> "cmdrcarrier:{cmdr}" -> marketId
// -> "carrier:{marketId}". A pilot can only ever link THEIR OWN carrier (resolved from their
// signed identity, never the request body). We relay server-side (chosen model) so we validate
// and log before touching Raven's unauthenticated API. Raven call is time-boxed + the whole
// handler is deadline-raced so a slow Raven can never bare-502 us (mirrors /ingest/build).
const RAVEN = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net";
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const MID = /^\d{1,20}$/;
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36";
const RAVEN_TIMEOUT_MS = 6000;
const OVERALL_DEADLINE_MS = 20000;
const json = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" } });
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
}
async function ravenFetch(path, init) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RAVEN_TIMEOUT_MS);
  try { return await fetch(RAVEN + path, Object.assign({}, init || {}, { signal: ctrl.signal })); }
  finally { clearTimeout(timer); }
}

// Resolve the caller's own carrier from their signed identity. Returns { me, cmdr, carrier }.
async function resolveSelf(request, env) {
  const me = callerEmail(request);
  if (!me) return { me: "", cmdr: "", carrier: null };
  let cmdr = "";
  try { const v = await env.BUILDS.get("cmdrlink:" + me); if (v) { const o = JSON.parse(v); cmdr = (o && o.cmdr) || ""; } } catch (e) {}
  let carrier = null;
  if (cmdr) {
    let marketId = "";
    try { const v = await env.BUILDS.get("cmdrcarrier:" + cmdr.toLowerCase()); if (v) { const o = JSON.parse(v); marketId = (o && o.marketId) || ""; } } catch (e) {}
    if (marketId) {
      try { const v = await env.BUILDS.get("carrier:" + marketId); if (v) carrier = JSON.parse(v); } catch (e) {}
    }
  }
  return { me, cmdr, carrier };
}

// Is the caller's own carrier already linked to this build? Answered server-side so the
// browser never needs its own copy of the Raven base URL (it is already hardcoded in four
// files) and so a slow Raven degrades to "unknown" instead of hanging the button.
// Returns true / false / null, where NULL MEANS "could not ask" — the caller must not
// render that as "not linked", or the toggle would offer to link something already linked.
async function isLinkedToBuild(buildId, marketId) {
  if (!GUID.test(buildId) || !MID.test(marketId)) return null;
  try {
    const r = await ravenFetch("/api/project/" + buildId, { headers: { "User-Agent": UA, "Accept": "application/json" } });
    if (!r.ok) return null;
    const p = await r.json();
    if (!p || !Array.isArray(p.linkedFC)) return null;
    return p.linkedFC.some((f) => String((f && f.marketId) || f) === String(marketId));
  } catch (e) { return null; }
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const self = await resolveSelf(request, env);
  if (!self.me) return json({ ok: false, error: "no identity" }, 403);
  // Optional ?buildId= — lets the commander deck render LINK vs UNLINK without a second
  // round trip and without reaching Raven from the page.
  let linkedToBuild = null;
  const bid = String(new URL(request.url).searchParams.get("buildId") || "").toLowerCase().trim();
  if (bid && self.carrier && self.carrier.marketId) {
    linkedToBuild = await isLinkedToBuild(bid, String(self.carrier.marketId));
  }
  return json({ ok: true, me: self.me, cmdr: self.cmdr, bound: !!self.cmdr, carrier: self.carrier || null, linkedToBuild });
}

// One handler for both directions — they differ only by HTTP verb, so splitting them
// would be two copies of the identity checks and the audit log.
//   link   -> PUT    /api/project/{buildId}/fc/{marketId}
//   unlink -> DELETE /api/project/{buildId}/fc/{marketId}
// DELETE was confirmed supported by probing with a deliberately fake build id (200, "[]")
// rather than by assuming the verb pairs, and rather than destroying a real link to find
// out. It is forgiving: unlinking something that was never linked still returns 200.
async function handleRelay(request, env, mode) {
  const unlink = mode === "unlink";
  const self = await resolveSelf(request, env);
  if (!self.me) return json({ ok: false, error: "no identity" }, 403);
  if (!self.cmdr) return json({ ok: false, error: "cmdr not bound", need: "bind" }, 409);
  if (!self.carrier || !MID.test(String(self.carrier.marketId || ""))) return json({ ok: false, error: "no carrier on record for your cmdr", need: "carrier" }, 409);

  let body = {}; try { body = await request.json(); } catch (e) {}
  const buildId = String(body.buildId || "").toLowerCase().trim();
  if (!GUID.test(buildId)) return json({ ok: false, error: "invalid buildId" }, 400);
  const marketId = String(self.carrier.marketId);

  let status = 0, ravenOk = false, detail = "";
  try {
    const r = await ravenFetch("/api/project/" + buildId + "/fc/" + marketId, {
      method: unlink ? "DELETE" : "PUT",
      headers: { "User-Agent": UA, "Accept": "application/json" },
    });
    status = r.status; ravenOk = r.ok;
    if (!r.ok) detail = (await r.text().catch(() => "")).slice(0, 300);
  } catch (e) {
    detail = String(e); status = 0;
  }

  // Log every relay attempt (success or not) for the admin trail. `action` is recorded so
  // the trail can tell a link from an unlink — without it the two are indistinguishable.
  const logKey = "carrierlink:" + marketId + ":" + Date.now();
  try {
    await env.BUILDS.put(logKey, JSON.stringify({
      buildId, marketId, cmdr: self.cmdr, email: self.me, action: unlink ? "unlink" : "link",
      status, ok: ravenOk, ts: Date.now(), detail: detail || undefined,
    }), { expirationTtl: 60 * 60 * 24 * 90 });
  } catch (e) {}

  if (!ravenOk) {
    const reason = status === 0 ? "raven_unreachable" : ("raven_" + status);
    return json({ ok: false, error: (unlink ? "unlink_failed" : "link_failed"), reason, status, detail }, 502);
  }
  return json({ ok: true, linked: !unlink, buildId, marketId, carrier: self.carrier.name || self.carrier.callsign || marketId });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  let peek = {};
  try { peek = await request.clone().json(); } catch (e) {}
  const action = peek && peek.action;
  if (action !== "link" && action !== "unlink") return json({ ok: false, error: "unknown action" }, 400);
  const failKey = action === "unlink" ? "unlink_failed" : "link_failed";
  const deadline = new Promise((resolve) =>
    setTimeout(() => resolve(json({ ok: false, error: failKey, reason: "deadline" }, 502)), OVERALL_DEADLINE_MS));
  try {
    return await Promise.race([handleRelay(request, env, action), deadline]);
  } catch (e) {
    return json({ ok: false, error: failKey, reason: "handler_error", detail: String((e && e.message) || e) }, 502);
  }
}
