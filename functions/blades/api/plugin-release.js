// Cloudflare Pages Function — admin "Cut release" for the Blades Registrar plugin.
//
// The version string self-designates the channel: pure-numeric = stable ("2.0"),
// anything containing a letter = beta ("b2.1", "2.1B", "2.1-beta"), position-agnostic.
// Cutting a release fetches the corresponding committed zip, computes its SHA-256, and
// writes the channel manifest KV "plugin:release:{stable|beta}" = {version,sha256,notes,url}.
// navpull then hands each pilot the release for their channel; the plugin verifies the
// sha256 before it installs, so a bad/spoofed manifest can't push mismatched bytes.
//
// GET  /blades/api/plugin-release  (admin) -> { ok, stable, beta, pilots:[{cmdr,running,pending,ts}] }
// POST /blades/api/plugin-release  (admin) { version, notes } -> { ok, channel, version, sha256 }
const OWNER = "bigskinnywick@gmail.com";
const URLS = {
  stable: "https://wickdhub.com/blades/BladesRegistrar.zip",
  beta: "https://wickdhub.com/blades/BladesRegistrar-beta.zip",
};
const NOTES_MAX = 600;
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
async function adminList(env) {
  let admins = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const a = JSON.parse(v); if (Array.isArray(a)) admins = a.map(x => String(x).toLowerCase().trim()).filter(Boolean); } } catch (e) {}
  if (!admins.includes(OWNER)) admins.push(OWNER);
  return admins;
}
async function isAdmin(request, env) { const e = callerEmail(request); return !!e && (await adminList(env)).includes(e); }

function cleanVer(v) { const s = String(v || "").trim(); return /^[A-Za-z0-9.\-]{1,20}$/.test(s) ? s : ""; }
const isBeta = (v) => /[a-z]/i.test(String(v || ""));   // any letter => beta channel
function pubRelease(r) { return r && r.version ? { version: r.version, sha256: r.sha256 || "", notes: r.notes || "", url: r.url || "", ts: r.ts || 0, by: r.by || "" } : null; }

async function fetchZipBytes(env, url) {
  let resp = null;
  try { if (env.ASSETS && env.ASSETS.fetch) resp = await env.ASSETS.fetch(new Request(url)); } catch (e) {}
  if (!resp || !resp.ok) { try { resp = await fetch(url, { cf: { cacheTtl: 0 } }); } catch (e) {} }
  if (!resp || !resp.ok) throw new Error("zip not reachable (" + (resp ? resp.status : "no response") + ")");
  return new Uint8Array(await resp.arrayBuffer());
}
async function sha256hex(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("");
}
async function listPilots(env) {
  const out = [];
  try {
    const list = await env.BUILDS.list({ prefix: "cmdrver:" });
    for (const k of (list.keys || [])) {
      const rec = await readJson(env, k.name);
      if (rec) out.push({ cmdr: k.name.slice("cmdrver:".length), running: rec.running || "", pending: rec.pending || "", ts: rec.ts || 0 });
    }
  } catch (e) {}
  out.sort((a, b) => (b.ts || 0) - (a.ts || 0));
  return out;
}

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  return json({
    ok: true,
    stable: pubRelease(await readJson(env, "plugin:release:stable")),
    beta: pubRelease(await readJson(env, "plugin:release:beta")),
    pilots: await listPilots(env),
    urls: URLS,
  });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const version = cleanVer(body.version);
  if (!version) return json({ ok: false, error: "valid version required (letters+digits+.-, e.g. 2.1 or b2.1)" }, 400);
  const channel = isBeta(version) ? "beta" : "stable";
  const url = URLS[channel];
  let sha256;
  try { sha256 = await sha256hex(await fetchZipBytes(env, url)); }
  catch (e) { return json({ ok: false, error: "could not read " + channel + " zip (" + url + "): " + e.message }, 502); }
  const notes = String(body.notes || "").slice(0, NOTES_MAX);
  const rec = { version, sha256, notes, url, ts: Date.now(), by: callerEmail(request) };
  try { await env.BUILDS.put("plugin:release:" + channel, JSON.stringify(rec)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, channel, version, sha256, url });
}
