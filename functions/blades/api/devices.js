// Cloudflare Pages Function — device approval (step 2 of 2) and device management.
//
// GET    /blades/api/devices              -> { me, cmdr, pending[], devices[] }
// POST   /blades/api/devices  { code }    -> approve a pending pairing, mint the token
// DELETE /blades/api/devices  { deviceId }-> revoke a device
//
// ─── THE SECURITY PROPERTY ───────────────────────────────────────────────────
// Access-gated. The approver's identity comes from the signed Access JWT, never
// from the request body, and the commander comes from THEIR OWN cmdrlink binding.
// So a pilot can only ever approve a device that asked to be them. Adam cannot
// approve a device claiming to be Templar57, and neither can anyone else — that
// request shows up in Templar57's list and nobody else's.
//
// This is what makes /ingest/pair safe to leave open: the open half can only
// ASK, and the half that can GRANT requires a real login.
//
// ─── THE TOKEN IS SHOWN EXACTLY ONCE ─────────────────────────────────────────
// We store sha256(token), never the token. That means we genuinely cannot show
// it again later, and it means a KV dump — or one of our own backups — is not a
// file full of working credentials. If a pilot loses it they pair again; that's
// a 20-second inconvenience in exchange for the store never holding live secrets.
import {
  json, cleanCmdr, sha256hex, randomId, K_TOKEN, K_DEVICES, K_PAIR, SQ,
} from "../../_lib/ingest-auth.js";

function b64urlToStr(s) { s = s.replace(/-/g, "+").replace(/_/g, "/"); while (s.length % 4) s += "="; return atob(s); }
function callerEmail(request) {
  let e = (request.headers.get("Cf-Access-Authenticated-User-Email") || "").toLowerCase().trim();
  if (e) return e;
  const jwt = request.headers.get("Cf-Access-Jwt-Assertion");
  if (jwt) {
    const p = jwt.split(".");
    if (p.length === 3) {
      try { const c = JSON.parse(b64urlToStr(p[1])); if (c && c.email) return String(c.email).toLowerCase().trim(); } catch (_) {}
    }
  }
  return "";
}

async function boundCmdr(env, email) {
  try {
    const v = await env.BUILDS.get("cmdrlink:" + email);
    if (v) { const o = JSON.parse(v); return cleanCmdr(o && o.cmdr); }
  } catch (e) {}
  return "";
}

async function readDevices(env, cmdrLower) {
  try {
    const v = await env.BUILDS.get(K_DEVICES(cmdrLower));
    if (v) { const a = JSON.parse(v); if (Array.isArray(a)) return a; }
  } catch (e) {}
  return [];
}

// Never emit the hash — it's not a secret, but it's the lookup key and there is
// no reason for a browser to hold it.
const publicDevice = (d) => ({
  deviceId: d.deviceId, device: d.device, approvedTs: d.approvedTs,
  lastSeenTs: d.lastSeenTs || 0, country: d.country || "",
});

export async function onRequestGet({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);

  const cmdr = await boundCmdr(env, me);
  if (!cmdr) return json({ ok: true, me, cmdr: "", bound: false, pending: [], devices: [] });
  const cmdrLower = cmdr.toLowerCase();

  // Only pending requests naming THIS pilot's commander are ever visible.
  const pending = [];
  try {
    const list = await env.BUILDS.list({ prefix: `sq:${SQ}:pair:` });
    for (const k of list.keys) {
      const v = await env.BUILDS.get(k.name);
      if (!v) continue;
      const o = JSON.parse(v);
      if (!o || String(o.cmdr || "").toLowerCase() !== cmdrLower) continue;
      pending.push({
        code: k.name.slice(`sq:${SQ}:pair:`.length),
        device: o.device, ts: o.ts, country: o.country || "",
      });
    }
  } catch (e) {}
  pending.sort((a, b) => (b.ts || 0) - (a.ts || 0));

  // Liveness comes from the TOKEN record, which the heartbeat stamps — the index
  // row only ever knew when a PC was paired, which is the least interesting fact
  // about it. Reading the token per device also cross-checks the two: an index
  // row whose token is gone is a stale row, and saying so beats showing a
  // revoked PC as if it were still linked.
  const raw = await readDevices(env, cmdrLower);
  const devices = [];
  for (const d of raw) {
    let live = null;
    try { const v = await env.BUILDS.get(K_TOKEN(d.hash)); if (v) live = JSON.parse(v); } catch (e) {}
    devices.push({
      ...publicDevice(d),
      lastSeenTs: (live && Number(live.lastSeenTs)) || 0,
      stale: !live,   // index says linked, token says otherwise
    });
  }
  devices.sort((a, b) => (b.approvedTs || 0) - (a.approvedTs || 0));

  return json({ ok: true, me, cmdr, bound: true, pending, devices });
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);

  const cmdr = await boundCmdr(env, me);
  if (!cmdr) return json({ ok: false, error: "bind your CMDR name before approving a device" }, 409);
  const cmdrLower = cmdr.toLowerCase();

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const code = String(body.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  if (!code) return json({ ok: false, error: "code required" }, 400);

  let pend = null;
  try { const v = await env.BUILDS.get(K_PAIR(code)); if (v) pend = JSON.parse(v); } catch (e) {}
  if (!pend) return json({ ok: false, error: "no such pairing request (they expire after 10 minutes)" }, 404);

  // ★ The check the whole design rests on. The pending row named a commander;
  // the approver's commander comes from their Access login. They must match.
  if (String(pend.cmdr || "").toLowerCase() !== cmdrLower) {
    return json({ ok: false, error: "that request is not for your commander" }, 403);
  }

  const devices = await readDevices(env, cmdrLower);
  if (devices.length >= 10) return json({ ok: false, error: "device limit reached — revoke one first" }, 429);

  // The plugin proved possession of a secret by sending its hash at request time.
  // We mint a token the plugin does NOT yet have... so instead we bless the hash
  // it already committed to: the plugin keeps its own secret and starts using it.
  // Nothing secret ever crosses this endpoint in either direction.
  const hash = String(pend.hash || "").toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ ok: false, error: "malformed pairing request" }, 400);

  const deviceId = pend.deviceId || randomId(8);
  const rec = {
    cmdr, email: me, deviceId,
    device: pend.device || "EDMC plugin",
    country: pend.country || "",
    approvedTs: Date.now(), approvedBy: me,
  };

  try {
    await env.BUILDS.put(K_TOKEN(hash), JSON.stringify(rec));
    devices.push({ ...rec, hash });
    await env.BUILDS.put(K_DEVICES(cmdrLower), JSON.stringify(devices));
    await env.BUILDS.delete(K_PAIR(code));
  } catch (e) {
    return json({ ok: false, error: "write failed" }, 500);
  }

  return json({ ok: true, cmdr, approved: publicDevice(rec) });
}

export async function onRequestDelete({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const me = callerEmail(request);
  if (!me) return json({ ok: false, error: "no identity" }, 403);

  const cmdr = await boundCmdr(env, me);
  if (!cmdr) return json({ ok: false, error: "no bound cmdr" }, 409);
  const cmdrLower = cmdr.toLowerCase();

  let body = {};
  try { body = await request.json(); } catch (e) {}
  const deviceId = String(body.deviceId || "").replace(/[^0-9a-f]/g, "").slice(0, 32);
  if (!deviceId) return json({ ok: false, error: "deviceId required" }, 400);

  const devices = await readDevices(env, cmdrLower);
  const hit = devices.find((d) => d.deviceId === deviceId);
  if (!hit) return json({ ok: false, error: "no such device" }, 404);

  const rest = devices.filter((d) => d.deviceId !== deviceId);
  try {
    // Delete the token record FIRST. If the second write fails we've left a
    // stale index row, which is cosmetic — the reverse order would leave a live
    // credential with no way to see it in the UI.
    if (hit.hash) await env.BUILDS.delete(K_TOKEN(hit.hash));
    await env.BUILDS.put(K_DEVICES(cmdrLower), JSON.stringify(rest));
  } catch (e) {
    return json({ ok: false, error: "write failed" }, 500);
  }

  return json({ ok: true, cmdr, revoked: deviceId, devices: rest.map(publicDevice) });
}
