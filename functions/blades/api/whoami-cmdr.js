// Cloudflare Pages Function — pilot identity binding (email <-> in-game CMDR).
//
// The board authenticates a pilot by email (Cloudflare Access), but claims,
// carriers and architect data are keyed by in-game CMDR name. This route lets a
// logged-in pilot bind their own email to their CMDR ONCE, so self-service pages
// (carrier link, architect management) can scope to "their" systems.
//
// GET    /blades/api/whoami-cmdr                 -> { me, cmdr, bound }
// PUT    /blades/api/whoami-cmdr  { cmdr }        -> bind caller's email to a CMDR
// DELETE /blades/api/whoami-cmdr                  -> unbind
//
// Access-gated at the network layer (any Access user). A pilot can only ever set
// their OWN email->CMDR mapping — callerEmail comes from the signed Access JWT,
// not the request body, so there's nothing to spoof. Storage: same BUILDS KV,
// key "cmdrlink:{email}" -> { cmdr, ts }. Non-GUID key -> rides in export other{}.
const OWNER = "bigskinnywick@gmail.com";
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
// ED CMDR names: letters/digits/space and a few separators, capped. Reject empties.
function cleanCmdr(v) {
  const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim();
  if (!s) return "";
  if (!/^[\w .'\-]{1,40}$/.test(s)) return "";
  return s.slice(0, 40);
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  let cmdr = "";
  try { const v = await env.BUILDS.get("cmdrlink:" + me); if (v) { const o = JSON.parse(v); cmdr = (o && o.cmdr) || ""; } } catch (e) {}
  return json({ ok: true, me, cmdr, bound: !!cmdr });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const cmdr = cleanCmdr(body.cmdr);
  if (!cmdr) return json({ ok: false, error: "invalid cmdr" }, 400);
  await env.BUILDS.put("cmdrlink:" + me, JSON.stringify({ cmdr, ts: Date.now() }));
  return json({ ok: true, me, cmdr, bound: true });
}

export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);
  await env.BUILDS.delete("cmdrlink:" + me);
  return json({ ok: true, me, cmdr: "", bound: false });
}
