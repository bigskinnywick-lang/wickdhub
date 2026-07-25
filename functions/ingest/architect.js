/**
 * /ingest/architect — lightweight read-only endpoint.
 * Returns the architect for a system by scanning KV for sibling builds.
 * Covers completed builds that Raven no longer exposes via /api/system/.
 *
 * GET /ingest/architect?system=Col%20285%20Sector%20BU-O%20b7-3
 * → { "architect": "Templar57", "source": "board-sibling", "build": "Moy Engineering Silo" }
 * → { "architect": null }  (no sibling with an architect found)
 *
 * Drop this file into functions/ingest/architect.js in the wickdhub repo and push.
 */

export async function onRequestGet({ env, request }) {
  const url = new URL(request.url);
  const system = url.searchParams.get("system");
  if (!system) {
    return json({ architect: null, error: "missing ?system= parameter" });
  }

  try {
    // List all KV keys (build entries are bare UUIDs; skip prefixed keys like carrier:, cmdr:, ticker:)
    const list = await env.BUILDS.list();
    for (const key of list.keys) {
      if (key.name.includes(":")) continue; // skip non-build entries
      const val = await env.BUILDS.get(key.name, "json");
      if (!val) continue;
      // Match by system name (case-insensitive)
      if ((val.system || "").toLowerCase() !== system.toLowerCase()) continue;
      const arch = val.architect;
      if (arch) {
        return json({
          architect: arch,
          source: val.architectSource || "board-sibling",
          build: val.name || key.name,
        });
      }
    }
  } catch (e) {
    return json({ architect: null, error: "kv_error", detail: e.message }, 500);
  }

  return json({ architect: null });
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
