// Negative-control tests for per-device ingest auth.
//
// Run: node tests/ingest-auth.test.mjs
//
// ─── WHY THESE ARE WRITTEN THIS WAY ──────────────────────────────────────────
// The point of this file is NOT to show that the happy path works. It is to show
// that the forbidden paths FAIL. A test suite that only ever proves "a valid
// token is accepted" would pass just as happily against a function that accepts
// everything — which is the exact trap that let the actor sweep *.md only and
// report itself healthy.
//
// So every rule gets a matched pair: the thing that should work, and the thing
// that must not. If you add a rule, add both halves.
//
// This runs the REAL module against a fake KV, rather than re-implementing the
// logic in the test — asserting against a copy of the code proves nothing about
// the code.
import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
if (!globalThis.crypto) globalThis.crypto = webcrypto;

const {
  authIngest, stampBatch, sha256hex, K_TOKEN, cleanCmdr, safeEqual, pairCode,
} = await import("../functions/_lib/ingest-auth.js");

// ── minimal in-memory stand-in for a KV namespace ───────────────────────────
function fakeKV(seed = {}) {
  const m = new Map(Object.entries(seed));
  return {
    _m: m,
    async get(k) { return m.has(k) ? m.get(k) : null; },
    async put(k, v) { m.set(k, v); },
    async delete(k) { m.delete(k); },
    async list({ prefix }) { return { keys: [...m.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })) }; },
  };
}
const req = (headers = {}) => ({ headers: { get: (h) => headers[h] ?? headers[h.toLowerCase()] ?? null } });
const u = (qs) => new URL("https://wickdhub.com/ingest/navpull?" + qs);

const LEGACY = "legacy-shared-key-value";
const TOKEN = "device-token-aaaaaaaaaaaaaaaaaaaa";
const OTHER_TOKEN = "device-token-bbbbbbbbbbbbbbbbbbbb";

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}

const env = async () => {
  const kv = fakeKV();
  await kv.put(K_TOKEN(await sha256hex(TOKEN)), JSON.stringify({ cmdr: "BIGSKINNY", email: "a@b.c", deviceId: "dev1" }));
  return { BUILDS: kv, INGEST_KEY: LEGACY };
};

console.log("\nDEVICE TOKEN — the commander must come from the credential");
await t("valid token authenticates and derives the commander", async () => {
  const e = await env();
  const a = await authIngest(req({ Authorization: "Bearer " + TOKEN }), e, {}, null);
  assert.equal(a.ok, true);
  assert.equal(a.cmdr, "BIGSKINNY");
  assert.equal(a.via, "device");
});
await t("NEGATIVE: an unknown token is refused (not silently downgraded to legacy)", async () => {
  const e = await env();
  const a = await authIngest(req({ Authorization: "Bearer " + OTHER_TOKEN }), e, { key: LEGACY, cmdr: "BIGSKINNY" }, null);
  assert.equal(a.ok, false, "a bad token must not fall through to the shared key");
  assert.equal(a.status, 401);
});
await t("NEGATIVE: a revoked token stops working immediately", async () => {
  const e = await env();
  await e.BUILDS.delete(K_TOKEN(await sha256hex(TOKEN)));
  const a = await authIngest(req({ Authorization: "Bearer " + TOKEN }), e, {}, null);
  assert.equal(a.ok, false);
});
await t("NEGATIVE: a token cannot act as a DIFFERENT commander", async () => {
  const e = await env();
  const a = await authIngest(req({ Authorization: "Bearer " + TOKEN }), e, { cmdr: "Templar57" }, null);
  assert.equal(a.ok, false, "claiming another cmdr with a valid token must be refused");
  assert.equal(a.status, 403);
});
await t("a token MAY name its own commander (harmless agreement)", async () => {
  const e = await env();
  const a = await authIngest(req({ Authorization: "Bearer " + TOKEN }), e, { cmdr: "bigskinny" }, null);
  assert.equal(a.ok, true);
});

console.log("\nLEGACY SHARED KEY — unchanged during migration, off by config after");
await t("legacy key still works while migrating", async () => {
  const e = await env();
  const a = await authIngest(req(), e, { key: LEGACY, cmdr: "Templar57" }, null);
  assert.equal(a.ok, true);
  assert.equal(a.via, "legacy");
  assert.equal(a.cmdr, "Templar57");
});
await t("NEGATIVE: a wrong shared key is refused", async () => {
  const e = await env();
  const a = await authIngest(req(), e, { key: "not-the-key", cmdr: "X" }, null);
  assert.equal(a.ok, false);
  assert.equal(a.status, 401);
});
await t("NEGATIVE: INGEST_LEGACY_OFF=1 retires the shared key without a deploy", async () => {
  const e = await env();
  e.INGEST_LEGACY_OFF = "1";
  const a = await authIngest(req(), e, { key: LEGACY, cmdr: "Templar57" }, null);
  assert.equal(a.ok, false, "the env flip must actually close the old door");
});
await t("...and a device token still works after legacy is retired", async () => {
  const e = await env();
  e.INGEST_LEGACY_OFF = "1";
  const a = await authIngest(req({ Authorization: "Bearer " + TOKEN }), e, {}, null);
  assert.equal(a.ok, true);
});

console.log("\nNAVPULL — GET, token in the query string");
await t("token via ?tok= authenticates", async () => {
  const e = await env();
  const a = await authIngest(req(), e, null, u("tok=" + TOKEN));
  assert.equal(a.ok, true);
  assert.equal(a.cmdr, "BIGSKINNY");
});
await t("NEGATIVE: ?tok= bound to one cmdr cannot poll as another", async () => {
  const e = await env();
  const a = await authIngest(req(), e, null, u("tok=" + TOKEN + "&cmdr=Templar57"));
  assert.equal(a.ok, false, "navpull leaks a pilot's nav target + settings — this must not cross");
  assert.equal(a.status, 403);
});

console.log("\nBATCH STAMPING — authenticating the envelope is not authenticating its contents");
await t("NEGATIVE: a device batch cannot attribute rows to other commanders", () => {
  const out = stampBatch(
    [{ systemAddress: "1", cmdr: "Templar57" }, { systemAddress: "2", cmdr: "XELDUS" }],
    { via: "device", cmdr: "BIGSKINNY" },
  );
  assert.deepEqual(out.map((r) => r.cmdr), ["BIGSKINNY", "BIGSKINNY"],
    "every row of a 200-row backfill must be forced to the token's own commander");
});
await t("legacy batches are left exactly as they were", () => {
  const rows = [{ cmdr: "Templar57" }, { cmdr: "XELDUS" }];
  assert.deepEqual(stampBatch(rows, { via: "legacy", cmdr: "" }).map((r) => r.cmdr), ["Templar57", "XELDUS"]);
});

console.log("\nSTORAGE — a KV dump must not be a file full of working credentials");
await t("only the HASH of a token is ever stored", async () => {
  const e = await env();
  const dump = JSON.stringify([...e.BUILDS._m.entries()]);
  assert.ok(!dump.includes(TOKEN), "the raw token must never appear in KV");
  assert.ok(dump.includes(await sha256hex(TOKEN)), "the hash is what we look up by");
});

console.log("\nHELPERS");
await t("cleanCmdr strips the CMDR prefix and rejects junk", () => {
  assert.equal(cleanCmdr("  CMDR BigSkinny "), "BigSkinny");
  assert.equal(cleanCmdr("<script>"), "");
  assert.equal(cleanCmdr(""), "");
});
await t("safeEqual is correct (constant-time, but still has to be RIGHT)", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "ab"), false);
});
await t("pair codes avoid characters people misread at 1am", () => {
  for (let i = 0; i < 200; i++) assert.ok(!/[01OIL]/.test(pairCode()));
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
