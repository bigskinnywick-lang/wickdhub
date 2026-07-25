// Cloudflare Pages Function — "Squad Net Usage" glance.
// Server-side proxy to the Cloudflare GraphQL Analytics API so the token never
// touches the browser. Admin-gated. Reads:
//   - zone HTTP traffic (httpRequests1dGroups): requests, cached, page views, unique visitors
//   - account KV operations (kvOperationsAdaptiveGroups): read/write/list/delete counts
//
// GET /blades/api/usage -> { ok, zone, days:[{date,requests,cached,pageViews,uniques}],
//                            kv:[{date,actionType,requests}], errors:[...] }
//
// Requires a Pages secret CF_API_TOKEN with **Account Analytics: Read** and
// **Zone: Read** (to resolve the zone id). Account id from env CF_ACCOUNT_ID or the
// hardcoded default. Degrades gracefully: any piece that fails is reported in `errors`
// and simply omitted, so the page still renders what it can.
const OWNER = "bigskinnywick@gmail.com";
const ACCOUNT_DEFAULT = "d8ad5e450a31c4fdeb32f635f2041e8f";
const ZONE_NAME = "wickdhub.com";
const GQL = "https://api.cloudflare.com/client/v4/graphql";
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
async function isAdmin(request, env) {
  const e = callerEmail(request); if (!e) return false;
  let a = [];
  try { const v = await env.BUILDS.get("admin:emails"); if (v) { const arr = JSON.parse(v); if (Array.isArray(arr)) a = arr.map(x => String(x).toLowerCase().trim()); } } catch (_) {}
  if (!a.includes(OWNER)) a.push(OWNER);
  return a.includes(e);
}
const ymd = (d) => d.toISOString().slice(0, 10);

export async function onRequestGet({ request, env }) {
  if (!(await isAdmin(request, env))) return json({ ok: false, error: "forbidden" }, 403);
  const token = env && env.CF_API_TOKEN;
  if (!token) return json({ ok: false, error: "CF_API_TOKEN not set", days: [], kv: [], errors: ["CF_API_TOKEN secret missing"] });
  const account = (env && env.CF_ACCOUNT_ID) || ACCOUNT_DEFAULT;
  const errors = [];
  const auth = { "authorization": "Bearer " + token, "content-type": "application/json" };
  const now = new Date();
  const since = ymd(new Date(now.getTime() - 7 * 86400000));
  const until = ymd(now);

  // 1) resolve zone id by name
  let zoneTag = "", zone = ZONE_NAME;
  try {
    const r = await fetch(GQL.replace("/graphql", "/zones?name=" + encodeURIComponent(ZONE_NAME)), { headers: auth });
    const j = await r.json();
    if (j && j.success && j.result && j.result[0]) zoneTag = j.result[0].id;
    else errors.push("zone lookup: " + (j && j.errors ? JSON.stringify(j.errors).slice(0, 160) : "not found"));
  } catch (e) { errors.push("zone lookup failed: " + String(e).slice(0, 120)); }

  // 2) combined GraphQL: zone http + account kv
  let days = [], kv = [];
  const q = `{ viewer {
    ${zoneTag ? `zones(filter:{zoneTag:"${zoneTag}"}) {
      httpRequests1dGroups(limit:14, orderBy:[date_ASC], filter:{date_geq:"${since}", date_leq:"${until}"}) {
        dimensions { date } sum { requests cachedRequests pageViews } uniq { uniques }
      }
    }` : ``}
    accounts(filter:{accountTag:"${account}"}) {
      kvOperationsAdaptiveGroups(limit:200, orderBy:[date_ASC], filter:{date_geq:"${since}", date_leq:"${until}"}) {
        dimensions { date actionType } sum { requests }
      }
    }
  } }`;
  try {
    const r = await fetch(GQL, { method: "POST", headers: auth, body: JSON.stringify({ query: q }) });
    const j = await r.json();
    if (j && j.errors && j.errors.length) errors.push("graphql: " + JSON.stringify(j.errors).slice(0, 220));
    const v = j && j.data && j.data.viewer;
    if (v) {
      const z = v.zones && v.zones[0];
      if (z && z.httpRequests1dGroups) days = z.httpRequests1dGroups.map(g => ({
        date: g.dimensions.date, requests: g.sum.requests || 0, cached: g.sum.cachedRequests || 0,
        pageViews: g.sum.pageViews || 0, uniques: (g.uniq && g.uniq.uniques) || 0,
      }));
      const acc = v.accounts && v.accounts[0];
      if (acc && acc.kvOperationsAdaptiveGroups) kv = acc.kvOperationsAdaptiveGroups.map(g => ({
        date: g.dimensions.date, actionType: g.dimensions.actionType, requests: g.sum.requests || 0,
      }));
    }
  } catch (e) { errors.push("graphql failed: " + String(e).slice(0, 120)); }

  return json({ ok: true, zone, zoneTag: !!zoneTag, since, until, days, kv, errors });
}
