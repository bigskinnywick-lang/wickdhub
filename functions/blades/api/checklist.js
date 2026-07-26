// Cloudflare Pages Function — test-pilot checklist results.
//
// A test pilot ticks the items that passed and submits; we store their run and expose
// an aggregate of what has been confirmed (by whom). That record is durable, so when we
// build the next checklist we can assume already-confirmed items are good.
//
// GET  /blades/api/checklist?key=<checklistKey>  (Access-gated)
//   -> { ok, me, mine:{items,note,ts,cmdr}|null, verified:{ cid:{count,by:[names],lastTs} } }
// POST /blades/api/checklist  (Access-gated) { key, items:[cid...], note? }
//   -> { ok, saved }
//
// Storage: KV "check:{key}:{email}" = { items, note, ts, email, cmdr }. Keyed by the
// signed-in email (always present), with the bound CMDR stored for display.
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
async function readJson(env, key) { try { const v = await env.BUILDS.get(key); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
async function resolveCmdr(env, email) { const o = await readJson(env, "cmdrlink:" + email); return (o && o.cmdr) ? String(o.cmdr) : ""; }
const cleanKey = (v) => { const s = String(v || "").trim(); return /^[A-Za-z0-9.\-]{1,40}$/.test(s) ? s : ""; };
const cleanCid = (v) => (/^[A-Za-z0-9]{1,16}$/.test(String(v || "")) ? String(v) : "");
const nameFor = (rec) => (rec && rec.cmdr) ? rec.cmdr : String((rec && rec.email || "").split("@")[0] || "pilot");

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const key = cleanKey(new URL(request.url).searchParams.get("key"));
  if (!key) return json({ ok: false, error: "key required" }, 400);
  const prefix = "check:" + key + ":";
  const verified = {};
  let mine = null;
  try {
    const list = await env.BUILDS.list({ prefix });
    for (const k of (list.keys || [])) {
      const rec = await readJson(env, k.name);
      if (!rec || !Array.isArray(rec.items)) continue;
      const who = nameFor(rec);
      if (k.name === prefix + email) mine = { items: rec.items, note: rec.note || "", ts: rec.ts || 0, cmdr: rec.cmdr || "" };
      for (const cid of rec.items) {
        const c = cleanCid(cid); if (!c) continue;
        if (!verified[c]) verified[c] = { count: 0, by: [], lastTs: 0 };
        verified[c].count++;
        if (!verified[c].by.includes(who)) verified[c].by.push(who);
        if ((rec.ts || 0) > verified[c].lastTs) verified[c].lastTs = rec.ts || 0;
      }
    }
  } catch (e) {}
  return json({ ok: true, me: email.split("@")[0], mine, verified });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const key = cleanKey(body.key);
  if (!key) return json({ ok: false, error: "key required" }, 400);
  const items = Array.isArray(body.items) ? body.items.map(cleanCid).filter(Boolean).slice(0, 200) : [];
  const note = String(body.note || "").slice(0, 1000);
  const cmdr = await resolveCmdr(env, email);
  const rec = { items, note, ts: Date.now(), email, cmdr };
  try { await env.BUILDS.put("check:" + key + ":" + email, JSON.stringify(rec)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, saved: items.length });
}
