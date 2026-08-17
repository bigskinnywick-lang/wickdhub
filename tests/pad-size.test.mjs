// Execution test for hull-derived landing pad size on the colonization board.
//
// Run: node tests/pad-size.test.mjs
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
// Two call sites, ONE derived value, and they have DIFFERENT SEMANTICS:
//
//   • the Ardent drawer SORTS small pads down but never hides them — deliberate,
//     it is what makes "surface only if I have no other choice" work
//   • Inara's pi3 is a hard FILTER — it excludes
//
// Unifying them carelessly breaks one or the other, so both are asserted here.
//
// The bug being fixed: pi3=1 (Inara's default, Small) shipped in every link this
// board has ever produced, and PAD_REQ=3 hardcoded Large for every pilot. The
// fix must not simply swap one wrong constant for another — a small-ship pilot
// must not have valid stops filtered away.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const HTML = readFileSync(fileURLToPath(new URL("../docs/blades/colonization/index.html", import.meta.url)), "utf8");

const grab = (re, what) => {
  const m = HTML.match(re);
  assert.ok(m, `could not find ${what} — did the page change shape?`);
  return m[0];
};
const SHIP_PAD_SRC = grab(/const SHIP_PAD=\{[\s\S]*?\};/, "SHIP_PAD map");
const PADFN_SRC = grab(/function padForShip[\s\S]*?\n  \}/, "padForShip");

const padForShip = new Function(`${SHIP_PAD_SRC}\n${PADFN_SRC}\nreturn padForShip;`)();
// padReq() with the flag on, mirroring the page
const padReq = (ship) => padForShip(ship) || 3;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}

console.log("\nHULL → PAD");
t("large haulers resolve to Large", () => {
  for (const s of ["type9", "anaconda", "cutter", "federation_corvette", "type7", "belugaliner"]) {
    assert.equal(padForShip(s), 3, s);
  }
});
t("medium hulls resolve to Medium", () => {
  for (const s of ["python", "krait_mkii", "asp", "type6", "mandalay"]) {
    assert.equal(padForShip(s), 2, s);
  }
});
t("small hulls resolve to Small", () => {
  for (const s of ["sidewinder", "cobramkiii", "eagle", "empire_courier", "dolphin"]) {
    assert.equal(padForShip(s), 1, s);
  }
});
t("ED's ship names are matched case-insensitively", () => {
  assert.equal(padForShip("Type9"), 3);
  assert.equal(padForShip("  ANACONDA "), 3);
});
t("an unknown hull is reported as unknown, not guessed", () => {
  assert.equal(padForShip("some_ship_frontier_ships_next_year"), 0,
    "0 means 'we do not know' — the caller decides the fallback, and says so in the UI");
  assert.equal(padForShip(""), 0);
});
t("...and the fallback is Large, because haulers are the common case here", () => {
  assert.equal(padReq("some_ship_frontier_ships_next_year"), 3);
});

console.log("\n★ THE BUG — every Inara link asked for the SMALLEST pad");
t("NEGATIVE: pi3 is no longer hardcoded to 1", () => {
  assert.ok(!/pi3=1&/.test(HTML.replace(/\$\{[^}]*\}/g, "X")),
    "a literal pi3=1 means the fix did not reach the Inara link builder");
});
t("pi3 is driven by the derived value", () => {
  assert.match(HTML, /pi3=\$\{PAD_DERIVE\?padReq\(\):1\}/);
});
t("★ pi10 is left ALONE — it is 'order by Distance', not a pad size", () => {
  assert.match(HTML, /pi10=3/, "pi10 must stay 3; it was measured, and it is a sort not a filter");
});

console.log("\n★ THE TWO SEMANTICS MUST STAY DIFFERENT");
t("the Ardent drawer SORTS by pad — it must not filter", () => {
  const rank = grab(/const _pr=padReq\(\);const ap=[^\n]*/, "ranking line");
  assert.match(rank, /\?1:0/, "small pads are scored down");
  assert.ok(!/filter\(.*maxLandingPadSize/.test(HTML),
    "nothing may REMOVE a station for pad size — 'surface only if I have no other choice' depends on it");
});
t("a small-pad station is still SHOWN, just badged", () => {
  assert.match(HTML, /padbad=s\.maxLandingPadSize<padReq\(\)/);
  assert.match(HTML, /b-padbad/, "it gets a badge, not a deletion");
});

console.log("\nROLLOUT");
t("it is opt-in until tested — default behaviour is unchanged", () => {
  assert.match(HTML, /const PAD_DERIVE=/);
  assert.match(HTML, /pad=1/);
});
t("PAD_REQ survives only as the fallback constant", () => {
  assert.match(HTML, /function padReq\(\)\{ return PAD_DERIVE \? MY_PAD : PAD_REQ; \}/);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
