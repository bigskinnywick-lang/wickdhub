// Cloudflare Pages Function — PUBLIC read of the home "welcome message" (Wicked Wisdom).
//
// The Admiral's Desk saves the welcome message to KV "home:wisdom" via the Access-GATED
// /blades/api/wisdom (leadership only). The public home page can't read that gated route,
// so signed-out visitors would only ever see the page's CONFIG default. THIS endpoint is
// the public mirror: same KV value, no Access gate, so wickdhub.com/blades reflects the
// Admiral's live edit for everyone. Read-only — writes still go through the gated PUT.
//
// GET /blades/welcome -> { ok, text, author, role, updatedTs }
//
// Lives OUTSIDE /blades/api on purpose: the Access app gates /blades/api, /blades/admin
// and /blades/signin, leaving /blades/welcome public like the home page itself.
const SEED = {
  text: "You found us because you were looking for a crew that actually flies together. That's what the Blades are. We don't run spreadsheets and roll-call — the tools watch the work and we go build. Fly how you like, tell us what you're into, and lean on the wing when it's time to move something big. Welcome aboard, Commander.",
  author: "ADMIRAL WICKEDWISDOM66",
  role: "Onyx Blades Squadron",
};
const json = (o, s) => new Response(JSON.stringify(o), {
  status: s || 200,
  headers: {
    "content-type": "application/json",
    // Light cache: edits appear within ~30s, KV stays cheap under public traffic.
    "cache-control": "public, max-age=30",
  },
});

export async function onRequestGet({ env }) {
  if (!env || !env.BUILDS) return json({ ok: true, ...SEED, updatedTs: null });
  let w = null;
  try { const v = await env.BUILDS.get("home:wisdom"); if (v) { const o = JSON.parse(v); if (o && typeof o.text === "string") w = o; } } catch (e) {}
  if (!w) return json({ ok: true, ...SEED, updatedTs: null });
  return json({
    ok: true,
    text: w.text || SEED.text,
    author: w.author || SEED.author,
    role: w.role || SEED.role,
    updatedTs: w.updatedTs || null,
  });
}
