// Cloudflare Pages Function — browser-facing claims ledger admin route.
// GET    /blades/api/claims                                  -> { claims:[{systemAddress,architect,system,ts,via}] }
// PUT    /blades/api/claims  { systemAddress, architect, system?, via? }  -> upsert a claim (manual correction)
// DELETE /blades/api/claims  { systemAddress }               -> remove a claim
//
// The plugin writes claims via /ingest/claim (INGEST_KEY-gated — not usable from a
// browser session). THIS route is the human-facing sibling for the admin console:
// Access-gated at the network layer, and admin-gated on top. Same BUILDS namespace,
// same "claim:{systemAddress}" keys — so /ingest/claim and this route interoperate.
const SA = /^\d{1,20}$/;
const OWNER = "bigskinnywick@gmail.com";
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const callerEmail = (request) => (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
async function adminList(env) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(e => String(e).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER);
  return admins;
}
async function isAdmin(request, env) { const e = callerEmail(request); return !!e && (await adminList(env)).includes(e); }

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  const claims = [];
  let cursor;
  do {
    const l = await env.BUILDS.list({ prefix: "claim:", cursor });
    for (const k of l.keys) {
      let m = {};
      try { const v = await env.BUILDS.get(k.name); if (v) m = JSON.parse(v); } catch (e) {}
      claims.push({ systemAddress: k.name.slice(6), architect: m.architect || "", system: m.system || "", ts: m.ts || null, via: m.via || "" });
    }
    cursor = l.list_complete ? null : l.cursor;
  } while (cursor);
  return json({ claims });
}

export async function onRequestPut({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const sa = String(body.systemAddress || "").trim();
  if (!SA.test(sa)) return json({ ok: false, error: "invalid systemAddress" }, 400);
  const architect = String(body.architect || "").trim();
  if (!architect) return json({ ok: false, error: "architect required" }, 400);
  const rec = { architect: architect.slice(0, 80), system: String(body.system || "").slice(0, 80), ts: Date.now(), via: String(body.via || "admin").slice(0, 20) };
  await env.BUILDS.put("claim:" + sa, JSON.stringify(rec));
  return json({ ok: true, systemAddress: sa, ...rec });
}

export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const sa = String(body.systemAddress || "").trim();
  if (!SA.test(sa)) return json({ ok: false, error: "invalid systemAddress" }, 400);
  await env.BUILDS.delete("claim:" + sa);
  return json({ ok: true, systemAddress: sa });
}
