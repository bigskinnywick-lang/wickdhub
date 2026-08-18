// Cloudflare Pages Function — "nav push" from the board to a commander's own PC clipboard.
//
// Tablet/phone browsers can't write the PC clipboard, so the board can't hand a
// system name to the game that way. Instead the board POSTs the target here, keyed
// to the caller's OWN commander, and the Blades Registrar plugin (running on that
// commander's PC) polls /ingest/navpull and drops it on the PC clipboard for a
// galaxy-map paste. Fully per-pilot: identity comes from the signed Access JWT, so
// a commander can only push to their own clipboard.
//
// POST /blades/api/navpush { system } -> { ok, cmdr, system }
//
// Storage: BUILDS KV, key "nav:{cmdrLower}" -> { system, ts, by }. Short TTL so a
// stale target clears itself. Access-gated at the network layer (enlisted only).
const TTL_S = 600;
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
// ED system names: letters, digits, spaces and - + . ' * / ( ) — kept tight but permissive.
function cleanSystem(v) {
  const s = String(v || "").trim();
  if (!s) return "";
  if (!/^[\w .,'\-+*/()]{1,60}$/.test(s)) return "";
  return s.slice(0, 60);
}
// Station names, 2026-08-17. NAME THE THREAT FIRST, because it is not XSS:
//
// This string is third-party text from Ardent, and it is headed for a path where
// it will be SPOKEN by COVAS and STRING-MATCHED against Status.json's
// `Destination.Name`. ★ The sharp edge is a control character — a newline or a
// tab surviving into a value that later reaches the PC clipboard is an ENTER or a
// TAB pressed inside the game's search box. That is OB-2 §6's rule (an untrusted
// string must never reach something that presses a key) arriving by a route §6
// did not anticipate, because §6 was written about chat.
//
// So: strip control characters and collapse whitespace FIRST, then allowlist.
// Deliberately more permissive than cleanSystem — station names legitimately
// carry ':' ("Orbital Construction Site: Collora's Progress"), and typographic
// apostrophes arrive from Ardent ("Zoline’s Inheritance"), which are folded to
// ASCII rather than stripped so the name still matches what the game displays.
//
// ⚠ Returns "" on a name that is entirely unusable. That is the SAME empty this
// change exists to fix — but it now means "we looked and it was junk" rather
// than "nobody wired the attribute up", and it can only happen to input that
// had no legitimate characters at all.
function cleanStation(v) {
  let s = String(v == null ? "" : v);
  s = s.replace(/[\u0000-\u001F\u007F]/g, " ");   // control chars -> space. THE KEYPRESS RISK.
  s = s.replace(/[\u2018\u2019\u02BC]/g, "'").replace(/[\u201C\u201D]/g, '"'); // fold smart quotes
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/[^\w .,'":\-+*/()&]/g, "");            // allowlist, station-shaped
  return s.slice(0, 60);
}

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);
  const email = callerEmail(request);
  if (!email) return json({ ok: false, error: "no identity" }, 403);
  const cmdr = await resolveCmdr(env, email);
  if (!cmdr) return json({ ok: false, error: "no CMDR bound to this account" }, 409);
  let body = {}; try { body = await request.json(); } catch (e) {}
  const system = cleanSystem(body.system);
  if (!system) return json({ ok: false, error: "system required" }, 400);
  const rec = { system, ts: Date.now(), by: cmdr };
  try { await env.BUILDS.put("nav:" + cmdr.toLowerCase(), JSON.stringify(rec), { expirationTtl: TTL_S }); }
  catch (e) { return json({ ok: false, error: "write failed" }, 500); }

  // ── 2026-08-16: keep the INTENT, additively ──────────────────────────────
  // Why the pilot went somewhere only ever existed in the browser: the supplier
  // drawer's srcCache is keyed "system|commodity" and is page-lifetime, so by
  // the time Docked or MarketBuy fires the reason for the trip is gone. The
  // journal can say where he went and eventually what he bought; it can never
  // say what he was looking for.
  //
  // ★ 2026-08-17 — the "hoard now, build nothing on it" fence is LIFTED (OB-2 §8).
  // A consumer is now expected: COVAS reads the station back on arrival. Two
  // conditions travel with it — speak only when the arrival system matches the
  // recorded intent system, and consume the record on speak, so a stale click is
  // never read back later.
  //
  // ⚠ AND THE FIELD IT NEEDS WAS EMPTY. `data-station` was never emitted by the
  // supplier drawer, so `b.dataset.station||''` read an attribute that did not
  // exist and every row written between 2026-08-16 and 2026-08-17 stored
  // station:"". Fixed on the page in the same change. Rows already in KV keep
  // their empty station — a consumer must treat "" as "not recorded", never as
  // "no station".
  //
  // ⚠ Strictly additive. A failure here must never break the plot-or-clipboard
  // path, which is why it is fire-and-forget below the nav write and why an
  // absent commodity is simply an unrecorded intent rather than a 400.
  const commodity = String(body.commodity || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);
  if (commodity) {
    try {
      const key = "sq:onyx:intent:" + cmdr.toLowerCase();
      let prev = [];
      const v = await env.BUILDS.get(key);
      if (v) { const o = JSON.parse(v); if (Array.isArray(o.recent)) prev = o.recent; }
      const recent = [{ system, commodity, station: cleanStation(body.station), ts: rec.ts }]
        .concat(prev)
        .slice(0, 50);   // a rolling window, not a permanent movement log
      await env.BUILDS.put(key, JSON.stringify({ recent, ts: rec.ts }));
    } catch (e) { /* never let hoarding break the actual job */ }
  }

  return json({ ok: true, cmdr, system, intent: !!commodity });
}

export async function onRequestGet() {
  return json({ ok: true, note: "Blades nav push. POST { system } (Access-gated) -> your PC clipboard via the plugin." });
}
