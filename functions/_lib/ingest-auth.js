// Shared ingest authentication for the Blades Registrar plugin.
//
// ─── WHY THIS FILE EXISTS ────────────────────────────────────────────────────
// Until 2026-08-16 every /ingest/* route did its own `body.key === env.INGEST_KEY`
// check and then TRUSTED `body.cmdr`. Two problems with that:
//
//   1. INGEST_KEY was a literal in plugin-src/BladesRegistrar/load.py, and this
//      repo is PUBLIC. The key was fetchable anonymously from raw.githubusercontent.
//      Anyone could write to any ingest route as ANY commander.
//   2. Even with a private key, the commander was a CLAIM IN THE BODY. One shared
//      secret cannot tell two pilots apart.
//
// The fix is per-device tokens: the commander is now DERIVED FROM THE CREDENTIAL
// rather than asserted by the caller. A stolen token only lets you be the one
// pilot it was issued to.
//
// This is the FIRST cross-file import in functions/. Underscore-prefixed dirs are
// not routed by Pages, so /_lib/* is importable but never reachable as a URL.
// ⚠ FIRST DEPLOY CHECK: hit /ingest/loadout with a bad key and confirm you get a
// 401 (helper loaded, working) and NOT a 500 (import failed).
//
// ─── MIGRATION ───────────────────────────────────────────────────────────────
// Dual-accept. A request may authenticate EITHER way:
//   • device token  -> cmdr derived from the token record          (the new way)
//   • INGEST_KEY    -> cmdr taken from the body, exactly as before (the old way)
//
// You cannot rotate a credential through a channel that credential gates:
// /ingest/navpull is both the auth-gated endpoint AND the only way a plugin
// learns an update exists. Kill the old key first and every deployed plugin goes
// silent and can never be told about the fix. So: add the new way, migrate
// everyone (watch cmdrver:*), THEN turn the old way off.
//
// Turning legacy off is an ENV FLIP, not a deploy — set INGEST_LEGACY_OFF=1 in
// Pages settings. Instant, and instantly reversible if it goes wrong.

// One squadron today. The identifier is carried anyway, because "which squadron"
// must never be answered by "there's only one" — free now, impossible to retrofit.
// NOTE: only NEW keys carry this prefix. Existing families (loadout:, claim:,
// cmdrlink: …) are left alone; renaming them would be a data migration.
export const SQ = "onyx";

// How stale a device's "last seen" may get before we spend a KV write on it.
// The heartbeat is every 5s; the card only ever renders this to the minute.
export const LASTSEEN_THROTTLE_MS = 5 * 60 * 1000;

export const K_TOKEN = (hash) => `sq:${SQ}:devtoken:${hash}`;
export const K_DEVICES = (cmdrLower) => `sq:${SQ}:devices:${cmdrLower}`;
export const K_PAIR = (code) => `sq:${SQ}:pair:${code}`;

export const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200,
  headers: { "content-type": "application/json", "cache-control": "no-store" },
});

const _enc = new TextEncoder();

// Tokens are stored ONLY as a hash. A KV dump — or one of our own backups — must
// never be a file full of working credentials.
export async function sha256hex(s) {
  const buf = await crypto.subtle.digest("SHA-256", _enc.encode(String(s)));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ED CMDR names: letters/digits/space and a few separators, capped.
export function cleanCmdr(v) {
  const s = String(v || "").replace(/^\s*(cmdr|commander)\s+/i, "").trim();
  if (!s) return "";
  if (!/^[\w .'\-]{1,40}$/.test(s)) return "";
  return s.slice(0, 40);
}

export function randomId(bytes) {
  const a = new Uint8Array(bytes || 16);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Human-readable pairing code. No 0/O/1/I/L — it gets read off a status line and
// typed by a tired person at 1am.
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export function pairCode() {
  const a = new Uint8Array(6);
  crypto.getRandomValues(a);
  return Array.from(a).map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join("");
}

// Constant-time string compare. Overkill for a game board, but a plain !== on a
// secret is the kind of thing that gets copied into somewhere it matters.
export function safeEqual(a, b) {
  const x = String(a || ""), y = String(b || "");
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

// Token may arrive as an Authorization header (POST bodies) or ?tok= (navpull is
// a GET the plugin builds as a query string).
function presentedToken(request, body, url) {
  const h = request.headers.get("Authorization") || "";
  const m = /^Bearer\s+([A-Za-z0-9._\-]{16,200})$/.exec(h.trim());
  if (m) return m[1];
  if (body && body.tok) return String(body.tok);
  if (url && url.searchParams.get("tok")) return String(url.searchParams.get("tok"));
  return "";
}

/**
 * Resolve who is calling an /ingest/* route.
 *
 * Returns { ok:true, cmdr, cmdrLower, via:"device"|"legacy", deviceId }
 *      or { ok:false, status, error }
 *
 * Pass the already-parsed body for POSTs, and the URL for GETs.
 *
 * opts.requireCmdr — default true. /ingest/station-type reports a fact about a
 * station and names no commander at all, so it opts out rather than being handed
 * a fake one.
 */
export async function authIngest(request, env, body, url, opts) {
  const requireCmdr = !opts || opts.requireCmdr !== false;
  if (!env || !env.BUILDS) return { ok: false, status: 500, error: "KV not bound" };

  // ── the new way: per-device token, commander DERIVED ────────────────────────
  const tok = presentedToken(request, body, url);
  if (tok) {
    let rec = null;
    try {
      const v = await env.BUILDS.get(K_TOKEN(await sha256hex(tok)));
      if (v) rec = JSON.parse(v);
    } catch (e) {}
    if (!rec || !rec.cmdr) return { ok: false, status: 401, error: "unknown or revoked device token" };

    const cmdr = cleanCmdr(rec.cmdr);
    if (!cmdr) return { ok: false, status: 401, error: "malformed device record" };

    // If the caller ALSO named a commander, it must be its own. A mismatch means
    // either a bug or someone trying it on; either way we want to hear about it
    // rather than silently prefer one.
    const claimed = cleanCmdr((body && body.cmdr) || (url && url.searchParams.get("cmdr")));
    if (claimed && claimed.toLowerCase() !== cmdr.toLowerCase()) {
      return { ok: false, status: 403, error: "token is not bound to that commander" };
    }

    // Stamp liveness so the board can show a PC that has gone quiet, not just
    // when it was paired. Throttled hard: this runs on a 5s heartbeat per pilot,
    // and an unthrottled write here would be the single hottest KV write in the
    // system for information nobody needs to the second.
    const now = Date.now();
    if (now - (Number(rec.lastSeenTs) || 0) > LASTSEEN_THROTTLE_MS) {
      rec.lastSeenTs = now;
      try { await env.BUILDS.put(K_TOKEN(await sha256hex(tok)), JSON.stringify(rec)); } catch (e) {}
    }

    return { ok: true, cmdr, cmdrLower: cmdr.toLowerCase(), via: "device", deviceId: rec.deviceId || "" };
  }

  // ── the old way: one shared key, commander CLAIMED ─────────────────────────
  if (String(env.INGEST_LEGACY_OFF || "") === "1") {
    return { ok: false, status: 401, error: "shared key retired — re-pair this device" };
  }
  const key = (body && body.key) || (url && url.searchParams.get("key")) || "";
  if (!env.INGEST_KEY || !safeEqual(key, env.INGEST_KEY)) {
    return { ok: false, status: 401, error: "unauthorized" };
  }
  const cmdr = cleanCmdr((body && body.cmdr) || (url && url.searchParams.get("cmdr")));
  if (requireCmdr && (!cmdr || cmdr.toLowerCase() === "unknown")) {
    return { ok: false, status: 400, error: "invalid cmdr" };
  }
  return { ok: true, cmdr, cmdrLower: (cmdr || "").toLowerCase(), via: "legacy", deviceId: "" };
}

/**
 * Force every row of a batch to the authenticated commander.
 *
 * /ingest/claim and /ingest/carrier accept up to 200 rows, each naming its own
 * cmdr — that's how the one-time journal backfill works. Left alone, a device
 * token would be able to backfill claims attributing systems to OTHER pilots,
 * which is precisely the forgery the token was introduced to stop. Authenticating
 * the envelope is not the same as authenticating its contents.
 *
 * Legacy callers are left exactly as they were, so the migration changes nothing
 * for a plugin that hasn't paired yet.
 */
export function stampBatch(items, auth) {
  if (!Array.isArray(items) || auth.via !== "device") return items;
  return items.map((it) => ({ ...(it && typeof it === "object" ? it : {}), cmdr: auth.cmdr }));
}
