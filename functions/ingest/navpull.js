// Cloudflare Pages Function — the plugin's read side of "nav push".
//
// The Blades Registrar plugin (on a commander's PC) polls this for that commander's
// latest galaxy-map nav target (pushed from the board via /blades/api/navpush) and
// drops it on the PC clipboard. Plugin-authed with INGEST_KEY (same as the other
// /ingest/* endpoints); the caller passes ?cmdr=. No caching — the plugin needs the
// freshest value and only calls it on its own timer.
//
// GET /ingest/navpull?key=...&cmdr=Name -> { ok, system, ts }  (system null if none)
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
function cleanCmdr(v) {
  const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim();
  return /^[\w .'\-]{1,40}$/.test(s) ? s.slice(0, 40) : "";
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const url = new URL(request.url);
  const key = url.searchParams.get("key") || "";
  if (!env.INGEST_KEY || key !== String(env.INGEST_KEY)) return json({ ok: false, error: "unauthorized" }, 401);
  const cmdr = cleanCmdr(url.searchParams.get("cmdr"));
  if (!cmdr) return json({ ok: false, error: "cmdr required" }, 400);
  let rec = null;
  try { const v = await env.BUILDS.get("nav:" + cmdr.toLowerCase()); if (v) rec = JSON.parse(v); } catch (e) {}
  if (!rec || !rec.system) return json({ ok: true, system: null, ts: 0 });
  return json({ ok: true, system: rec.system, ts: rec.ts || 0 });
}
