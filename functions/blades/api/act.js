// Cloudflare Pages Function — the generic "the pilot acted" lane (b3.22).
//
// WHY THIS EXISTS, separately from navpush: refocus-on-action needs a signal for actions
// that carry no payload. `navpush` says "here is a system, put it on my clipboard" and the
// refocus rides along; this says only "I just did something deliberate, hand me back to the
// game." Overloading navpush with an empty system would have made a nav record that means
// "no nav", which is the kind of shape that reads fine today and is a bug in six months.
//
// ★ OPT-IN PER BUTTON, by design (Adam's call 2026-08-12). Nothing calls this automatically
// and no middleware fires it on every POST. A control opts in by calling it, so a button
// added later cannot start stealing the pilot's foreground because nobody thought about it.
// The failure mode of forgetting to call it is "no refocus", which is the safe direction.
//
// POST /blades/api/act { kind } -> { ok, cmdr, kind, ts }
//
// Storage: BUILDS KV, key "act:{cmdrLower}" -> { kind, ts, by }. TTL is deliberately SHORT —
// the plugin's freshness gate rejects anything older than ~20s anyway, so a record outliving
// that is only a replay risk with no upside. Access-gated at the network layer (enlisted).
const TTL_S = 60;
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
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
// `kind` is a label for the log and the status line, never a branch: the plugin treats every
// kind identically. Kept to a tight charset and a short cap so it cannot become a payload.
function cleanKind(v) {
  const s = String(v || "").trim().toLowerCase();
  return /^[a-z0-9_-]{1,24}$/.test(s) ? s : "";
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  if (!cmdr) return json({ ok: false, error: "no CMDR bound to this account" }, 409);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const kind = cleanKind(body.kind) || "button";
  const ts = Date.now();
  try { await env.BUILDS.put("act:" + cmdr.toLowerCase(), JSON.stringify({ kind, ts, by: cmdr }), { expirationTtl: TTL_S }); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, cmdr, kind, ts });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades activation lane. POST { kind } (Access-gated) -> your plugin hands focus back to Elite." });
}
