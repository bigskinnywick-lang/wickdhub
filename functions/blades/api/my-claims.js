// Cloudflare Pages Function — SELF-SERVICE architect deck. A pilot manages only
// THEIR OWN claims (systems where the claim architect == their bound CMDR).
//
// GET    /blades/api/my-claims                         -> { me, cmdr, bound, windowDays, claims:[...] }
// PATCH  /blades/api/my-claims { systemAddress, system?, primaryDone? } -> correct one of MY claims
// DELETE /blades/api/my-claims { systemAddress }        -> release one of MY claims
//
// Identity: Access JWT -> email -> "cmdrlink:{email}" -> CMDR. Every write re-checks that the
// target claim's architect matches the caller's CMDR (case-insensitive) BEFORE touching it, so a
// pilot can never edit someone else's attribution. The admin route (/blades/api/claims) keeps its
// unrestricted powers; this one is deliberately scoped. Architect data is Blades-only — Raven has
// no set-architect endpoint — so nothing here relays to Raven; it's pure ledger cleanup.
//
// "primaryDone": a manual override. We can't always see from KV whether a primary port is built
// (that lives in Raven), so a pilot can mark it done; the hot-list endpoint then drops it. It only
// clears the countdown — it does NOT touch the architect attribution.
const SA = /^\d{1,20}$/;
const GUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const WINDOW_DAYS = 28;
const WINDOW_MS = WINDOW_DAYS * 24 * 60 * 60 * 1000;
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const norm = (s) => String(s || "").toLowerCase().trim();
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
}
async function callerCmdr(request, env) {
  const me = callerEmail(request);
  if (!me) return { me: "", cmdr: "" };
  let cmdr = "";
  try { const v = await env.BUILDS.get("cmdrlink:" + me); if (v) { const o = JSON.parse(v); cmdr = (o && o.cmdr) || ""; } } catch (e) {}
  return { me, cmdr };
}
// Load a claim only if it exists AND belongs to the caller's CMDR. Returns { claim } or { error }.
async function ownedClaim(env, sa, cmdr) {
  let m = null;
  try { const v = await env.BUILDS.get("claim:" + sa); if (v) m = JSON.parse(v); } catch (e) {}
  if (!m) return { error: "not found", status: 404 };
  if (norm(m.architect) !== norm(cmdr)) return { error: "not your claim", status: 403 };
  return { claim: m };
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const { me, cmdr } = await callerCmdr(request, env);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  if (!cmdr) return json({ ok: true, me, cmdr: "", bound: false, windowDays: WINDOW_DAYS, claims: [] });

  const now = Date.now();
  const mine = [];
  const builtSystems = new Set();
  let cursor;
  do {
    const l = await env.BUILDS.list({ cursor });
    for (const k of l.keys) {
      const name = k.name;
      if (name.startsWith("claim:")) {
        let m = null;
        try { const v = await env.BUILDS.get(name); if (v) m = JSON.parse(v); } catch (e) {}
        if (m && norm(m.architect) === norm(cmdr)) {
          mine.push({ systemAddress: name.slice(6), system: m.system || "", ts: Number(m.ts) || 0, primaryDone: !!m.primaryDone, via: m.via || "" });
        }
      } else if (GUID.test(name)) {
        let m = null;
        try { const v = await env.BUILDS.get(name); if (v) m = JSON.parse(v); } catch (e) {}
        if (m && m.system) builtSystems.add(norm(m.system));
      }
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);

  for (const c of mine) {
    const age = c.ts ? now - c.ts : null;
    c.hasBuild = !!(c.system && builtSystems.has(norm(c.system)));
    c.inWindow = age !== null && age >= 0 && age <= WINDOW_MS;
    c.daysLeft = c.ts ? Math.ceil((c.ts + WINDOW_MS - now) / 86400000) : null;
    c.status = c.primaryDone ? "primary_done" : (c.hasBuild ? "building" : (c.inWindow ? "not_started" : "window_passed"));
  }
  // Most urgent first: still-open not-started with least days left on top; settled ones sink.
  mine.sort((a, b) => {
    const rank = (x) => x.status === "not_started" ? 0 : x.status === "building" ? 1 : 2;
    return (rank(a) - rank(b)) || ((a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
  });
  return json({ ok: true, me, cmdr, bound: true, windowDays: WINDOW_DAYS, claims: mine });
}

export async function onRequestPatch({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const { me, cmdr } = await callerCmdr(request, env);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  if (!cmdr) return json({ ok: false, error: "cmdr not bound", need: "bind" }, 409);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const sa = String(body.systemAddress || "").trim();
  if (!SA.test(sa)) return json({ ok: false, error: "invalid systemAddress" }, 400);
  const owned = await ownedClaim(env, sa, cmdr);
  if (owned.error) return json({ ok: false, error: owned.error }, owned.status);

  const rec = owned.claim;
  if (typeof body.system === "string") rec.system = body.system.slice(0, 80);
  if (typeof body.primaryDone === "boolean") rec.primaryDone = body.primaryDone;
  rec.architect = cmdr;            // keep attribution pinned to the owner
  await env.BUILDS.put("claim:" + sa, JSON.stringify(rec));
  return json({ ok: true, systemAddress: sa, system: rec.system || "", primaryDone: !!rec.primaryDone });
}

export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const { me, cmdr } = await callerCmdr(request, env);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  if (!cmdr) return json({ ok: false, error: "cmdr not bound", need: "bind" }, 409);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const sa = String(body.systemAddress || "").trim();
  if (!SA.test(sa)) return json({ ok: false, error: "invalid systemAddress" }, 400);
  const owned = await ownedClaim(env, sa, cmdr);
  if (owned.error) return json({ ok: false, error: owned.error }, owned.status);
  await env.BUILDS.delete("claim:" + sa);
  return json({ ok: true, systemAddress: sa, released: true });
}
