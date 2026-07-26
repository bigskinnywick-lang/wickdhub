// Cloudflare Pages Function — admin "Cut release" for the Blades Registrar plugin.
//
// The version + suggested notes are read straight from the deployed zip's load.py
// (`PLUGIN_VERSION = "2.0"  # notes...`), so there is nothing to type and no chance of
// a typo mismatching what pilots actually run. The version self-designates the channel:
// pure-numeric = stable ("2.0"), anything with a letter = beta ("b2.1"), position-
// agnostic. Cutting reads the zip, verifies the version matches the channel, hashes the
// bytes, and writes KV "plugin:release:{stable|beta}" = {version,sha256,notes,url}.
//
// GET  /blades/api/plugin-release  (admin)
//   -> { ok, stable, beta, detected:{stable:{version,notes}|null, beta:{...}|null}, pilots, urls }
// POST /blades/api/plugin-release  (admin) { channel:"stable"|"beta", notes? }
//   -> { ok, channel, version, sha256 }   (version comes from the zip, not the client)
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
const isBeta = (v) => /[a-z]/i.test(String(v || ""));
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
async function inflateRaw(u8) {
  const cs = new DecompressionStream("deflate-raw");
  const w = cs.writable.getWriter(); w.write(u8); w.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}
// Minimal ZIP reader: scan local file headers for */load.py and return its bytes.
// Our zips are written by `zip` with sizes in the local header (no streamed descriptors).
function findLoadPy(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let i = 0;
  while (i + 30 <= u8.length && dv.getUint32(i, true) === 0x04034b50) {
    const flags = dv.getUint16(i + 6, true);
    const method = dv.getUint16(i + 8, true);
    const compSize = dv.getUint32(i + 18, true);
    const nameLen = dv.getUint16(i + 26, true);
    const extraLen = dv.getUint16(i + 28, true);
    const nameStart = i + 30;
    const name = new TextDecoder().decode(u8.subarray(nameStart, nameStart + nameLen)).replace(/\\/g, "/");
    const dataStart = nameStart + nameLen + extraLen;
    if ((name === "load.py" || name.endsWith("/load.py")) && compSize > 0) return { method, bytes: u8.subarray(dataStart, dataStart + compSize) };
    if ((flags & 0x08) && compSize === 0) break; // streamed sizes (data descriptor) unsupported — bail rather than loop
    i = dataStart + compSize; // dirs / empty entries have compSize 0 — just advance past them
  }
  return null;
}
async function readLoadPy(u8) {
  const e = findLoadPy(u8);
  if (!e) return null;
  if (e.method === 0) return new TextDecoder().decode(e.bytes);
  if (e.method === 8) return new TextDecoder().decode(await inflateRaw(e.bytes));
  return null;
}
function parseMeta(text) {
  if (!text) return null;
  const m = text.match(/PLUGIN_VERSION\s*=\s*["']([^"']+)["'][^\S\r\n]*(?:#\s*([^\r\n]*))?/);
  if (!m) return null;
  const notes = (m[2] || "").trim().replace(/^[A-Za-z0-9.\-]+:\s*/, ""); // drop a leading "2.0:" prefix
  return { version: m[1].trim(), notes };
}
// Fetch a channel's zip, parse version+notes from its load.py, keep bytes for hashing.
async function detect(env, url) {
  let bytes; try { bytes = await fetchZipBytes(env, url); } catch (e) { return null; }
  let meta = null; try { meta = parseMeta(await readLoadPy(bytes)); } catch (e) {}
  return meta ? { version: meta.version, notes: meta.notes, bytes } : null;
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
  const [sd, bd] = await Promise.all([detect(env, URLS.stable), detect(env, URLS.beta)]);
  return json({
    ok: true,
    stable: pubRelease(await readJson(env, "plugin:release:stable")),
    beta: pubRelease(await readJson(env, "plugin:release:beta")),
    detected: {
      stable: sd ? { version: sd.version, notes: sd.notes } : null,
      beta: bd ? { version: bd.version, notes: bd.notes } : null,
    },
    pilots: await listPilots(env),
    urls: URLS,
  });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const channel = body.channel === "beta" ? "beta" : (body.channel === "stable" ? "stable" : "");
  if (!channel) return json({ ok: false, error: "channel required (stable|beta)" }, 400);
  const url = URLS[channel];
  const d = await detect(env, url);
  if (!d) return json({ ok: false, error: "could not read a version from " + channel + " zip (" + url + ") — is it deployed?" }, 502);
  const version = cleanVer(d.version);
  if (!version) return json({ ok: false, error: "zip version string is invalid" }, 400);
  if (isBeta(version) !== (channel === "beta")) {
    return json({ ok: false, error: "zip version " + version + " is " + (isBeta(version) ? "a beta" : "a stable") + " build but you are cutting " + channel + " — build it into " + (isBeta(version) ? "BladesRegistrar-beta.zip" : "BladesRegistrar.zip") }, 400);
  }
  const sha256 = await sha256hex(d.bytes);
  const notes = (typeof body.notes === "string" && body.notes.trim()) ? body.notes.slice(0, NOTES_MAX) : d.notes;
  const rec = { version, sha256, notes, url, ts: Date.now(), by: callerEmail(request) };
  try { await env.BUILDS.put("plugin:release:" + channel, JSON.stringify(rec)); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }
  return json({ ok: true, channel, version, sha256 });
}
