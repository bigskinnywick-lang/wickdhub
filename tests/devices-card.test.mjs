// Execution test for docs/blades/_shell/devices.js
//
// Run: node tests/devices-card.test.mjs
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
// This card renders strings that came from a PLUGIN — device name, country — and
// during the migration window /ingest/pair is reachable by anyone. So the one
// place in this system where untrusted text meets an approval button is exactly
// here. `node --check` would tell us the file parses; it would not tell us the
// output is escaped. So we actually run it.
//
// Same rule as everywhere else in this suite: every check has a negative twin.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const SRC = readFileSync(fileURLToPath(new URL("../docs/blades/_shell/devices.js", import.meta.url)), "utf8");

// ── the smallest DOM that lets this file run ────────────────────────────────
function makeNode() {
  const node = {
    innerHTML: "",
    _handlers: [],
    querySelectorAll(sel) {
      const attr = /\[data-(\w+)\]/.exec(sel)?.[1];
      if (!attr) return [];
      const re = new RegExp(`data-${attr}="([^"]*)"`, "g");
      const out = [];
      let m;
      while ((m = re.exec(node.innerHTML))) {
        out.push({
          getAttribute: () => m[1],
          addEventListener: (_e, fn) => node._handlers.push(fn),
          set disabled(v) {}, set textContent(v) {},
        });
      }
      return out;
    },
  };
  return node;
}

let lastFetch = null;
const win = {
  toast: () => {},
  confirm: () => true,
  setInterval: () => 0,
  clearInterval: () => {},
};
const ctx = {
  window: win,
  document: { hidden: false },
  fetch: async (url, opt) => { lastFetch = { url, opt }; return { json: async () => FIXTURE }; },
  console,
  Date,
  Math,
  Number,
  String,
  JSON,
};
ctx.window.fetch = ctx.fetch;

let FIXTURE = { ok: true, bound: true, cmdr: "BIGSKINNY", pending: [], devices: [] };

// Execute the IIFE with our stubs in scope.
const run = new Function("window", "document", "fetch", "console", `${SRC}\nreturn window.Devices;`);
const Devices = run(win, ctx.document, ctx.fetch, console);

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}
const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("\nMOUNTING");
await t("the file executes and exposes Devices.mount", () => {
  assert.equal(typeof Devices?.mount, "function");
});

console.log("\nUNBOUND PILOT — cannot approve anything yet");
await t("tells an unbound pilot to bind first", async () => {
  FIXTURE = { ok: true, bound: false, pending: [], devices: [] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /Bind your CMDR name first/);
});

console.log("\nPENDING REQUESTS");
await t("renders a pending request with its code and an APPROVE button", async () => {
  FIXTURE = { ok: true, bound: true, cmdr: "BIGSKINNY",
    pending: [{ code: "PAIR42", device: "FLIGHT-OPS", ts: Date.now() - 30000, country: "US" }], devices: [] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /PAIR42/);
  assert.match(n.innerHTML, /FLIGHT-OPS/);
  assert.match(n.innerHTML, /data-approve="PAIR42"/);
});
await t("★ warns the pilot not to approve a code they didn't start", async () => {
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /Only approve a code you are looking at/,
    "this copy is the control that turns a forged request into a decline");
});

console.log("\nXSS — device names arrive from an open endpoint");
await t("NEGATIVE: a hostile device name cannot inject markup", async () => {
  FIXTURE = { ok: true, bound: true, cmdr: "BIGSKINNY",
    pending: [{ code: "AAAAAA", device: '<img src=x onerror="alert(1)">', ts: Date.now(), country: "" }],
    devices: [] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.ok(!n.innerHTML.includes("<img"), "raw tag reached the DOM string");
  assert.ok(!n.innerHTML.includes("onerror=\""), "raw handler reached the DOM string");
  assert.match(n.innerHTML, /&lt;img/, "should be escaped, not stripped");
});
await t("NEGATIVE: a hostile name cannot break out of the data- attribute", async () => {
  FIXTURE = { ok: true, bound: true, cmdr: "X",
    pending: [], devices: [{ deviceId: 'a" onclick="alert(1)', device: "x", approvedTs: Date.now() }] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.ok(!n.innerHTML.includes('onclick="alert(1)"'), "attribute break-out");
  assert.match(n.innerHTML, /&quot;/);
});

console.log("\nAPPROVED DEVICES");
await t("lists linked registrars with a REVOKE button", async () => {
  FIXTURE = { ok: true, bound: true, cmdr: "BIGSKINNY", pending: [],
    devices: [{ deviceId: "abc123", device: "FLIGHT-OPS", approvedTs: Date.now() - 86400000,
                lastSeenTs: Date.now() - 60000, country: "US", stale: false }] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /data-revoke="abc123"/);
  assert.match(n.innerHTML, /FLIGHT-OPS/);
  assert.match(n.innerHTML, /reported 1m ago/, "liveness, not just when it paired");
});
await t("a PC that has never reported says so rather than showing a stale pairing time", async () => {
  FIXTURE = { ok: true, bound: true, cmdr: "X", pending: [],
    devices: [{ deviceId: "d1", device: "PC", approvedTs: Date.now(), lastSeenTs: 0, stale: false }] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /no report yet/);
});
await t("NEGATIVE: a revoked-but-still-indexed PC is flagged, not shown as healthy", async () => {
  FIXTURE = { ok: true, bound: true, cmdr: "X", pending: [],
    devices: [{ deviceId: "d1", device: "PC", approvedTs: Date.now(), lastSeenTs: 0, stale: true }] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /link broken/, "a stale index row must not read as a working link");
});
await t("empty state points the pilot at where the code appears", async () => {
  FIXTURE = { ok: true, bound: true, cmdr: "BIGSKINNY", pending: [], devices: [] };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /status line/);
});

console.log("\nWIRING");
await t("it talks to /blades/api/devices with the session cookie", () => {
  assert.equal(lastFetch.url, "/blades/api/devices");
  assert.equal(lastFetch.opt.credentials, "same-origin");
});
await t("a failed response degrades to a message, not a blank card", async () => {
  FIXTURE = { ok: false, error: "boom" };
  const n = makeNode(); Devices.mount(n); await tick(); await tick();
  assert.match(n.innerHTML, /Could not load devices/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
