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

// Fake nodes now need querySelectorAll: renderMigration wires the retire /
// un-retire buttons after painting. Returning [] is honest — the click paths are
// exercised separately below by asserting the buttons are RENDERED, which is the
// part that can silently disappear.
const mkNode = () => ({ innerHTML: "", querySelectorAll: () => [] });
const nodes = {};
const $ = (id) => (nodes[id] = nodes[id] || mkNode());
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g,
  (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ago = (ts) => (ts ? "1m ago" : "never");

let REG_MIGRATION = [], REG_MIG_READY = false;
const api = () => Promise.resolve({});
const toast = () => {};
const run = new Function("$", "esc", "ago", "getState",
  `${SRC}\nreturn function(rows, ready){ REG_MIGRATION = rows; REG_MIG_READY = ready; renderMigration(); };`);
let REG_MIGRATION_ref, REG_MIG_READY_ref; // eslint-disable-line
const render = (function () {
  // renderMigration closes over REG_MIGRATION/REG_MIG_READY; rebuild with them injected.
  const f = new Function("$", "esc", "ago", "REG_MIGRATION", "REG_MIG_READY", "api", "toast", "window",
    `${SRC}\nrenderMigration();`);
  return (rows, ready) => { nodes.migVerdict = mkNode(); nodes.migRows = mkNode(); f($, esc, ago, rows, ready, api, toast, { confirm: () => true }); };
})();

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}
const V = () => nodes.migVerdict.innerHTML;
const R = () => nodes.migRows.innerHTML;

const READY_PILOT = { cmdr: "BIGSKINNY", bound: true, paired: 1, running: "b3.35", lastSeenTs: Date.now(), canPair: true, hasPlugin: true, state: "ready", ready: true };

console.log("\nREADY");
t("all-ready says so and names the switch", () => {
  render([READY_PILOT], true);
  assert.match(V(), /READY/);
  assert.match(V(), /INGEST_LEGACY_OFF=1/);
});

console.log("\n★ NOT READY — each blocker must be named, in the order they hit it");
t("NEGATIVE: a REPORTING but unpaired pilot blocks, and is named", () => {
  render([READY_PILOT,
    { cmdr: "wickd wanderer", bound: false, paired: 0, running: "b3.4", lastSeenTs: Date.now(), canPair: false, hasPlugin: true, state: "blocked", ready: false }], false);
  assert.match(V(), /NOT READY/);
  assert.match(V(), /wickd wanderer/, "the blocker must be named, not just counted");
  assert.match(R(), /NOT BOUND/);
});
t("★ a commander with NO plugin does not block — but the residual risk is stated", () => {
  render([READY_PILOT,
    { cmdr: "wickedwisdom66", bound: true, paired: 0, running: null, lastSeenTs: 0, canPair: null, hasPlugin: false, state: "n/a", ready: false }], true);
  assert.match(V(), /READY/);
  assert.match(V(), /no plugin we have ever seen/);
  assert.match(V(), /wickedwisdom66/);
  assert.match(V(), /waiting would not change that/,
    "an unseeable plugin cannot be waited for — say so rather than implying safety");
});
t("NEGATIVE: an unseen version still renders as unknown, never blank", () => {
  render([{ cmdr: "x", bound: true, paired: 1, running: null, lastSeenTs: 0, canPair: null, hasPlugin: true, state: "ready", ready: true }], true);
  assert.match(R(), /unknown — not seen in 14 days/);
});
t("an old build is reported as needing an update", () => {
  render([{ cmdr: "templar57", bound: true, paired: 0, running: "b3.10", lastSeenTs: Date.now(), canPair: false, hasPlugin: true, state: "blocked", ready: false }], false);
  assert.match(R(), /needs a newer build/);
});
t("★ an ALT nobody is bound to explains WHY it can never approve", () => {
  render([{ cmdr: "wickd wanderer", bound: false, paired: 0, running: "b3.4", lastSeenTs: Date.now(), canPair: true, hasPlugin: true, state: "blocked", ready: false }], false);
  assert.match(R(), /NOT BOUND/);
  assert.match(R(), /one email binds one CMDR/,
    "the real constraint has to be on screen, not just in a doc");
});
t("a bound pilot who has not approved is told only they can", () => {
  render([{ cmdr: "x", bound: true, paired: 0, running: "3.2", lastSeenTs: Date.now(), canPair: true, hasPlugin: true, state: "blocked", ready: false }], false);
  assert.match(R(), /only their own login/);
});
t("★ NEGATIVE: an UNRECOGNISED state must not render as healthy green", () => {
  render([{ cmdr: "x", bound: true, paired: 1, running: "3.2", lastSeenTs: Date.now(), canPair: true }], false);
  assert.ok(!/border-left:3px solid var\(--ok/.test(R()),
    "an unknown state tinting green is a fail-open — green must require an explicit ready");
});
t("★ NEGATIVE: the verdict never says READY while a row is outstanding", () => {
  render([READY_PILOT, { cmdr: "y", bound: false, paired: 0, running: "3.1", lastSeenTs: Date.now(), canPair: false, hasPlugin: true, state: "blocked", ready: false }], false);
  assert.ok(!/>READY/.test(V()) || /NOT READY/.test(V()),
    "a partial migration must never read as complete");
});

console.log("\n★ RETIRE — a decision with a name on it, not a hidden exclusion");
t("a blocked row offers a retire button", () => {
  render([{ cmdr: "wickd wanderer", bound: false, paired: 0, running: "b3.4", lastSeenTs: Date.now(), canPair: true, hasPlugin: true, state: "blocked", ready: false }], false);
  assert.match(R(), /data-retire="wickd wanderer"/);
});
t("a retired row does NOT block, and says the refusal is intended", () => {
  render([{ cmdr: "wickd wanderer", bound: false, paired: 0, running: "b3.4", lastSeenTs: Date.now(), canPair: true, hasPlugin: true, state: "retired", ready: false, retired: { by: "a@b.c", ts: Date.now(), reason: "alt, registrar removed" }, stillReporting: false }], true);
  assert.match(V(), /READY/);
  assert.match(R(), /refusing this registrar is intended/);
  assert.match(R(), /alt, registrar removed/);
});
t("★ a retirement is always reversible from where it was made", () => {
  render([{ cmdr: "x", bound: false, paired: 0, running: "3.1", lastSeenTs: Date.now(), canPair: false, hasPlugin: true, state: "retired", ready: false, retired: { by: "a", ts: Date.now(), reason: "" }, stillReporting: false }], true);
  assert.match(R(), /data-unretire="x"/,
    "a decision you cannot undo where you made it is a trap");
});
t("★★ NEGATIVE: a retired registrar that is STILL REPORTING is called out", () => {
  render([{ cmdr: "wickd wanderer", bound: false, paired: 0, running: "b3.4", lastSeenTs: Date.now(), canPair: true, hasPlugin: true, state: "retired", ready: false, retired: { by: "a", ts: Date.now(), reason: "" }, stillReporting: true }], true);
  assert.match(V(), /STILL REPORTING/,
    "reality beats the record — a stale decision must not cover a live plugin");
  assert.match(V(), /never actually removed/);
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
