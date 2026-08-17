// Execution test for the CREDENTIAL MIGRATION card in the admin console.
//
// Run: node tests/migration-card.test.mjs
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
// This card is the thing Adam will look at before setting INGEST_LEGACY_OFF=1.
// If it says READY when it isn't, pilots get stranded with a plugin that has
// been refused and no way to recover except a manual reinstall.
//
// The gate it replaces was unsound in a specific way: watching cmdrver: alone
// reads "everyone migrated" when it actually means "the ones who stayed away
// stopped being counted", because that key has a 14-day TTL. So the load-bearing
// test here is the one where a pilot is INVISIBLE — the card must refuse to call
// that ready, and must say so rather than silently omitting him.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML = readFileSync(fileURLToPath(new URL("../docs/blades/admin/index.html", import.meta.url)), "utf8");

// Pull renderMigration out of the page and run it for real.
const start = HTML.indexOf("function renderMigration(){");
assert.ok(start > 0, "renderMigration not found in the admin console");
const end = HTML.indexOf("function populateMemberSelect(){", start);
const SRC = HTML.slice(start, end);

const nodes = {};
const $ = (id) => (nodes[id] = nodes[id] || { innerHTML: "" });
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (ts) => (ts ? "1m ago" : "never");

let REG_MIGRATION = [], REG_MIG_READY = false;
const run = new Function("$", "esc", "ago", "getState",
  `${SRC}\nreturn function(rows, ready){ REG_MIGRATION = rows; REG_MIG_READY = ready; renderMigration(); };`);
let REG_MIGRATION_ref, REG_MIG_READY_ref; // eslint-disable-line
const render = (function () {
  // renderMigration closes over REG_MIGRATION/REG_MIG_READY; rebuild with them injected.
  const f = new Function("$", "esc", "ago", "REG_MIGRATION", "REG_MIG_READY",
    `${SRC}\nrenderMigration();`);
  return (rows, ready) => { nodes.migVerdict = { innerHTML: "" }; nodes.migRows = { innerHTML: "" }; f($, esc, ago, rows, ready); };
})();

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}
const V = () => nodes.migVerdict.innerHTML;
const R = () => nodes.migRows.innerHTML;

const READY_PILOT = { cmdr: "BIGSKINNY", bound: true, paired: 1, running: "b3.35", lastSeenTs: Date.now(), canPair: true, ready: true };

console.log("\nREADY");
t("all-ready says so and names the switch", () => {
  render([READY_PILOT], true);
  assert.match(V(), /READY/);
  assert.match(V(), /INGEST_LEGACY_OFF=1/);
});

console.log("\n★ NOT READY — each blocker must be named, in the order they hit it");
t("NEGATIVE: an INVISIBLE pilot is not counted as ready", () => {
  render([READY_PILOT,
    { cmdr: "wickd wanderer", bound: false, paired: 0, running: null, lastSeenTs: 0, canPair: null, ready: false }], false);
  assert.match(V(), /NOT READY/);
  assert.match(V(), /1 of 2/);
  assert.match(R(), /unknown — not seen in 14 days/,
    "absence must be shown as absence, never quietly omitted");
  assert.match(R(), /cannot tell which build/);
});
t("an old build is reported as needing an update", () => {
  render([{ cmdr: "templar57", bound: true, paired: 0, running: "b3.10", lastSeenTs: Date.now(), canPair: false, ready: false }], false);
  assert.match(R(), /needs a newer build/);
});
t("an unbound pilot is told it is theirs to do", () => {
  render([{ cmdr: "x", bound: false, paired: 0, running: "3.2", lastSeenTs: Date.now(), canPair: true, ready: false }], false);
  assert.match(R(), /bind it themselves/);
});
t("a bound pilot who has not approved is told only they can", () => {
  render([{ cmdr: "x", bound: true, paired: 0, running: "3.2", lastSeenTs: Date.now(), canPair: true, ready: false }], false);
  assert.match(R(), /only their own login/);
});
t("★ NEGATIVE: the verdict never says READY while a row is outstanding", () => {
  render([READY_PILOT, { cmdr: "y", bound: false, paired: 0, running: null, lastSeenTs: 0, canPair: null, ready: false }], false);
  assert.ok(!/>READY/.test(V()) || /NOT READY/.test(V()),
    "a partial migration must never read as complete");
});

console.log("\nRENDERING");
t("a ready pilot shows all three chips ticked", () => {
  render([READY_PILOT], true);
  const ticks = (R().match(/✓/g) || []).length;
  assert.equal(ticks, 3, "pairing-capable, bound, paired");
});
t("no blocker line is drawn for a ready pilot", () => {
  render([READY_PILOT], true);
  assert.ok(!R().includes("↳"));
});
t("NEGATIVE: a hostile CMDR name cannot inject markup", () => {
  render([{ cmdr: '<img src=x onerror="alert(1)">', bound: true, paired: 1, running: "3.2", lastSeenTs: Date.now(), canPair: true, ready: true }], true);
  assert.ok(!R().includes("<img"));
  assert.match(R(), /&lt;img/);
});
t("empty roster degrades to a message", () => {
  render([], false);
  assert.match(R(), /No members known yet/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
