// Cloudflare Pages Function — device pairing request (step 1 of 2).
//
// A plugin generates a secret locally, hashes it, and asks to be paired with a
// commander. This route records a PENDING request and hands back a short code.
// Nothing is granted here. The request is inert until the real pilot — signed in
// through Cloudflare Access, which is the only thing that actually proves who
// they are — approves it at /blades/api/devices.
//
// POST /ingest/pair  { cmdr, hash, device? }  -> { ok, code, expiresInS }
//
// ─── WHY THIS ROUTE IS UNAUTHENTICATED, ON PURPOSE ───────────────────────────
// It could have been gated by INGEST_KEY, but then pairing would die the moment
// the shared key is retired — and a brand-new pilot installing the plugin next
// month still has to get their first token somehow. So the route is open and
// made HARMLESS instead: a pending row grants nothing, expires in 10 minutes,
// and can only ever be approved by the pilot whose own bound CMDR it names.
//
// Which gives a property worth having: a forged pairing attempt doesn't fail
// silently in the dark, it turns up in that pilot's approval list as a device
// they don't recognise. The attack becomes a notification.
//
// The plugin never sends its secret here — only sha256(secret). We couldn't leak
// a working credential from this endpoint even if the pending rows were dumped.
import { json, cleanCmdr, pairCode, randomId, K_PAIR, K_DEVICES, K_TOKEN } from "../_lib/ingest-auth.js";

const PAIR_TTL_S = 600;        // 10 minutes to walk to the browser and click
const MAX_PENDING_PER_CMDR = 5; // cheap spam ceiling on an open route
const MAX_DEVICES_PER_CMDR = 10;

export async function onRequestPost({ request, env }) {
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);

  let body = {};
  try { body = await request.json(); } catch (e) {}

  const cmdr = cleanCmdr(body.cmdr);
  if (!cmdr || cmdr.toLowerCase() === "unknown") return json({ ok: false, error: "invalid cmdr" }, 400);

  // sha256 hex of the plugin's locally-generated secret. The secret itself never
  // travels at pairing time.
  const hash = String(body.hash || "").toLowerCase().trim();
  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ ok: false, error: "invalid hash" }, 400);

  const device = String(body.device || "").replace(/[^\w .'\-]/g, "").slice(0, 40) || "EDMC plugin";

  const cmdrLower = cmdr.toLowerCase();

  // Ceiling on approved devices, so an approved-but-forgotten pile can't grow
  // unbounded and make the approval list useless to read.
  try {
    const dv = await env.BUILDS.get(K_DEVICES(cmdrLower));
    if (dv) {
      const list = JSON.parse(dv);
      if (Array.isArray(list) && list.length >= MAX_DEVICES_PER_CMDR) {
        return json({ ok: false, error: "device limit reached — revoke one first" }, 429);
      }
    }
  } catch (e) {}

  // Spam ceiling on pending rows. list() over a short-TTL prefix is cheap here.
  try {
    const pend = await env.BUILDS.list({ prefix: `sq:onyx:pair:` });
    let mine = 0;
    for (const k of pend.keys) {
      const v = await env.BUILDS.get(k.name);
      if (!v) continue;
      const o = JSON.parse(v);
      if (o && String(o.cmdr || "").toLowerCase() === cmdrLower) mine++;
    }
    if (mine >= MAX_PENDING_PER_CMDR) {
      return json({ ok: false, error: "too many pending requests — approve or wait for expiry" }, 429);
    }
  } catch (e) {}

  const code = pairCode();
  const rec = {
    cmdr,
    hash,
    device,
    deviceId: randomId(8),
    ts: Date.now(),
    // Recorded for the approval card so an unrecognised request is legible:
    // "a device in <country> asked to be you" is a much better prompt than a bare code.
    country: request.headers.get("CF-IPCountry") || "",
  };

  try {
    await env.BUILDS.put(K_PAIR(code), JSON.stringify(rec), { expirationTtl: PAIR_TTL_S });
  } catch (e) {
    return json({ ok: false, error: "write failed" }, 500);
  }

  return json({ ok: true, code, expiresInS: PAIR_TTL_S, device });
}

// GET /ingest/pair?hash=<64 hex>  -> { ok, approved }
//
// "Has my pairing been approved yet?" The plugin polls this after asking, and
// only starts presenting its token once the answer is yes.
//
// That ordering matters: authIngest deliberately does NOT fall back to the shared
// key when a token is present but unknown (a bad token must fail loudly, not
// silently downgrade). So a plugin that started sending an unapproved token would
// lock itself out. It asks here first instead.
//
// Safe to leave open: the caller must already know sha256(secret), which means
// they hold the secret. It reveals one bit about a value only its owner can name,
// and the hash itself grants nothing.
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const hash = String(url.searchParams.get("hash") || "").toLowerCase().trim();

  if (!hash) {
    return json({
      ok: true,
      note: "Blades device pairing. POST { cmdr, hash, device } -> { code }. Approve at /blades/api/devices. GET ?hash= to check approval. A pending request grants nothing.",
    });
  }
  if (!/^[0-9a-f]{64}$/.test(hash)) return json({ ok: false, error: "invalid hash" }, 400);
  if (!env || !env.BUILDS) return json({ ok: false, error: "KV not bound" }, 500);

  let rec = null;
  try {
    const v = await env.BUILDS.get(K_TOKEN(hash));
    if (v) rec = JSON.parse(v);
  } catch (e) {}

  // Echo back the commander so the plugin can prove to itself it was approved as
  // who it expected — a mismatch means someone else's approval, and it should not
  // start speaking as them.
  return json({ ok: true, approved: !!(rec && rec.cmdr), cmdr: (rec && rec.cmdr) || "" });
}
