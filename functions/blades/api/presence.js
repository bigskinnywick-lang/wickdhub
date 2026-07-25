// Cloudflare Pages Function — squadron live presence (in-game / on-deck).
//
// "Who's flying right now" for the home deck. A heartbeat is written whenever a
// signed-in commander loads a Blades page (source:"web"); the EDMC Registrar
// plugin can later POST source:"game" for true in-game presence. Either way the
// list self-populates and self-expires — no manual roster.
//
// GET  /blades/api/presence            -> { ok, online:[{cmdr,source,ageSec,ts}], windowMin, ts }
// POST /blades/api/presence {source?}  -> stamp the caller's own heartbeat
//
// Identity comes from the signed Access JWT (never the body), resolved to the
// caller's bound CMDR via "cmdrlink:{email}". Access-gated at the network layer,
// so only enlisted commanders can read or write. Storage: BUILDS KV,
// key "presence:{cmdr-or-email}" -> { cmdr, source, ts }, TTL = window so the
// list decays on its own. Non-GUID key => ignored by the build list.
const WINDOW_MIN = 12;
const SOURCES = new Set(["web", "game"]);
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
// Behind Access, Pages Functions get the signed JWT assertion reliably (the header not always).
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) { const p = jwt.split("."); if (p.length === 3) { try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {} } }
  return "";
}
async function resolveCmdr(env, email) {
  try { const v = await env.BUILDS.get("cmdrlink:" + email); if (v) { const o = JSON.parse(v); if (o && o.cmdr) return String(o.cmdr); } } catch (e) {}
  return "";
}
function cleanCmdr(v) {
  const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim();
  if (!s || !/^[\w .'\-]{1,40}$/.test(s)) return "";
  return s.slice(0, 40);
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound", online: [] }, 500);
  if (!callerEmail(request)) return json({ ok: false, error: "no identity", online: [] }, 403);
  const now = Date.now();
  const cutoff = now - WINDOW_MIN * 60 * 1000;
  const best = new Map(); // cmdr -> freshest record
  try {
    const listing = await env.BUILDS.list({ prefix: "presence:" });
    for (const k of listing.keys) {
      let rec = null;
      try { const v = await env.BUILDS.get(k.name); if (v) rec = JSON.parse(v); } catch (e) {}
      if (!rec || !rec.ts || rec.ts < cutoff) continue;
      const cmdr = rec.cmdr || k.name.slice("presence:".length);
      const prev = best.get(cmdr);
      if (!prev || rec.ts > prev.ts) best.set(cmdr, { cmdr, source: rec.source || "web", ts: rec.ts });
    }
  } catch (e) {}
  const online = [...best.values()]
    .sort((a, b) => b.ts - a.ts)
    .map(r => ({ cmdr: r.cmdr, source: r.source, ts: r.ts, ageSec: Math.max(0, Math.round((now - r.ts) / 1000)) }));
  return json({ ok: true, online, windowMin: WINDOW_MIN, ts: now });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const source = SOURCES.has(body.source) ? body.source : "web";
  // Prefer the caller's bound CMDR; a body cmdr is only honoured for source:"game"
  // (the plugin) and still stored under the caller's own identity key.
  let cmdr = await resolveCmdr(env, me);
  if (!cmdr && source === "game") cmdr = cleanCmdr(body.cmdr);
  const label = cmdr || me.split("@")[0];
  const key = "presence:" + (cmdr ? cmdr.toLowerCase() : me);
  const rec = { cmdr: label, source, ts: Date.now(), email: me };
  try { await env.BUILDS.put(key, JSON.stringify(rec), { expirationTtl: WINDOW_MIN * 60 }); } catch (e) {
    return json({ ok: false, error: "write failed" }, 500);
  }
  return json({ ok: true, cmdr: label, source, ts: rec.ts });
}
