// Cloudflare Pages Function — PUBLIC Discord vitals for the storefront.
//
// WHY THIS EXISTS (read before "simplifying" it back to a browser fetch):
// The home page originally fetched https://discord.com/api/guilds/<id>/widget.json
// straight from the visitor's browser. That needs "Enable Server Widget" ON, which
// requires the Manage Server permission — and Adam does NOT have it on The Onyx
// Blades (WickedWisdom owns the server). With the widget off, Discord returns
// {"message":"Widget Disabled","code":50004} and the whole panel dies.
//
// The INVITE endpoint has no such gate: it returns approximate_member_count and
// approximate_presence_count for any valid invite code, no permission, no auth.
// That is enough for the count tile and the "◉ N ON DISCORD" line. We call it
// SERVER-SIDE so (a) CORS is irrelevant, (b) Discord sees one cached edge request
// per minute instead of one per visitor, (c) the invite code stays out of a
// hot client-side loop.
//
// Widget.json is still tried as a BONUS — if WickedWisdom ever flips the toggle,
// the online names list starts populating with zero code changes here or on the
// page. Until then `list` is simply empty and `widget` is false.
//
// ALSO carries inGame: the number of commanders on the wire right now. That count
// lives in the SAME BUILDS KV that /blades/api/presence reads, so we compute it
// here server-side and emit ONLY the integer — no cmdr names ever cross to a
// logged-out visitor. This is why showing prospects a live in-game number needs
// NO new Cloudflare Access rule: this path is already public, and the gated
// presence endpoint is untouched.
//
// GET /blades/api/discord-counts
//   -> { ok, members, online, inGame, list:[{name,status}], widget, guild, ts }
//
// NOTE: for logged-out prospects to read this, the path must be reachable WITHOUT
// Cloudflare Access (a "Bypass"/"Allow Everyone" policy for /blades/api/discord-counts),
// same as /blades/api/ticker-public.

const EDGE_TTL_S = 60;          // one upstream Discord call per minute per PoP
const PRESENCE_WINDOW_MIN = 12; // keep in step with WINDOW_MIN in presence.js
const UPSTREAM_TIMEOUT_MS = 4000;

// Permanent, unlimited-use invite (expires_at: null — verified 2026-08-08).
// If this is ever rotated, update it here AND in the three page locations:
//   docs/blades/index.html (CFG.DISCORD_INVITE), commander/index.html, colonization/index.html
const INVITE_CODE = "hSKWPJR9Yn";
const GUILD_ID    = "1122499424187334657";

const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200, headers: { "content-type": "application/json", "cache-control": "no-store" }
});
const cacheKeyFor = (request) => new Request(new URL(request.url).origin + new URL(request.url).pathname);
async function edgeMatch(request) { try { return await caches.default.match(cacheKeyFor(request)); } catch (e) { return null; } }
function edgePut(request, resp, ttl, waitUntil) {
  try {
    const r = resp.clone();
    r.headers.set("Cache-Control", "public, max-age=" + ttl);
    const p = caches.default.put(cacheKeyFor(request), r);
    if (waitUntil) waitUntil(p);
  } catch (e) {}
}

async function getJSON(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), UPSTREAM_TIMEOUT_MS);
  try {
    const r = await fetch(url, {
      signal: ctl.signal,
      headers: { accept: "application/json", "user-agent": "OnyxBladesSite/1.0 (+https://wickdhub.com/blades)" },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) { return null; } finally { clearTimeout(t); }
}

// Distinct commanders seen inside the presence window. Mirrors presence.js's
// dedupe (freshest record per cmdr) so the public number can never disagree with
// the member-side list. Returns null — not 0 — when KV is unavailable, so the
// page can tell "nobody flying" apart from "we couldn't ask".
async function countInGame(env) {
  if (!env || !env.BUILDS) return null;
  const cutoff = Date.now() - PRESENCE_WINDOW_MIN * 60 * 1000;
  const seen = new Set();
  try {
    const listing = await env.BUILDS.list({ prefix: "presence:" });
    for (const k of listing.keys) {
      let rec = null;
      try { const v = await env.BUILDS.get(k.name); if (v) rec = JSON.parse(v); } catch (e) {}
      if (!rec || !rec.ts || rec.ts < cutoff) continue;
      seen.add(String(rec.cmdr || k.name.slice("presence:".length)).toLowerCase());
    }
  } catch (e) { return null; }
  return seen.size;
}

export async function onRequestGet(context) {
  const { request, waitUntil, env } = context;

  const hit = await edgeMatch(request);
  if (hit) return hit;

  const code = (env && env.DISCORD_INVITE_CODE) || INVITE_CODE;
  const gid  = (env && env.DISCORD_GUILD_ID)    || GUILD_ID;

  // Both upstreams in parallel; neither is allowed to sink the response.
  const [inv, wid, inGame] = await Promise.all([
    getJSON("https://discord.com/api/v10/invites/" + encodeURIComponent(code) + "?with_counts=true"),
    getJSON("https://discord.com/api/guilds/" + encodeURIComponent(gid) + "/widget.json"),
    countInGame(env),
  ]);

  // Counts: invite is authoritative for TOTAL members (widget.json never reports it).
  // Widget wins on presence when available — it counts actual live sessions rather
  // than Discord's cached approximation.
  const members = (inv && typeof inv.approximate_member_count === "number")
    ? inv.approximate_member_count : null;
  const online = (wid && typeof wid.presence_count === "number")
    ? wid.presence_count
    : (inv && typeof inv.approximate_presence_count === "number" ? inv.approximate_presence_count : null);

  const list = (wid && Array.isArray(wid.members))
    ? wid.members.slice(0, 30).map(m => ({ name: String(m.username || "—"), status: String(m.status || "online") }))
    : [];

  if (members == null && online == null && inGame == null) {
    // Both upstreams failed — say so honestly rather than caching a fake zero.
    return json({ ok: false, error: "discord unreachable", members: null, online: null, list: [], widget: false }, 502);
  }

  const resp = json({
    ok: true,
    members,
    online,
    inGame,
    list,
    widget: !!(wid && Array.isArray(wid.members)),  // true once Manage Server flips the toggle
    guild: (inv && inv.guild && inv.guild.name) || "The Onyx Blades",
    ts: Date.now(),
  });
  resp.headers.set("Cache-Control", "public, max-age=" + EDGE_TTL_S);
  edgePut(request, resp, EDGE_TTL_S, waitUntil);
  return resp;
}
