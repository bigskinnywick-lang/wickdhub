// Proof for the 2026-08-17 Inara commodity capture.
// Run: node tests/inara-intent.test.mjs
//
// The Inara path is a CLIPBOARD HANDOFF: the pilot copies a system on Inara and
// the board reads his clipboard. The board never sees Inara's page, so a station
// is genuinely unavailable here — unlike the Ardent drawer, where the board made
// the query and holds the whole supplier row. The commodity, however, IS knowable,
// because the board generated the very link he clicked.
//
// The load-bearing test is the LAST one: that a commodity recorded via Inara
// normalizes to the SAME key the supplier-drawer path records. If it does not,
// intent[] quietly holds two spellings of one commodity and any consumer
// comparing them is wrong without ever erroring.
import assert from "node:assert/strict";
import fs from "node:fs";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}

const PAGE = "docs/blades/colonization/index.html";
const html = fs.readFileSync(PAGE, "utf8");
const NAV = fs.readFileSync("functions/blades/api/navpush.js", "utf8");

const escFC = (v) => String(v == null ? "" : v)
  .replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// Render the SHIPPING inaraLink template.
function renderInaraLink(name) {
  const line = html.split("\n").find((l) => l.trim().startsWith("function inaraLink("));
  assert.ok(line, "inaraLink not found");
  const tpl = line.match(/`(<a href=.*?)`;\}/)[1];
  const inaraUrl = () => "https://inara.cz/x";                    // stubbed, not under test
  const PROJECT = { systemName: "Col 285 Sector BU-O b7-3" };     // eslint-disable-line
  return eval("`" + tpl + "`");
}
const commFromLink = (h) => { const m = h.match(/data-comm="([^"]*)"/); return (m ? m[1] : undefined) || ""; };

console.log("\nPAGE — the commodity must be carried, not re-derived");
t("★ the Inara link emits data-comm", () => {
  assert.match(renderInaraLink("Titanium"), /data-comm="Titanium"/);
});
t("★ REGRESSION: the click handler can read a commodity off the link", () => {
  assert.notEqual(commFromLink(renderInaraLink("Land Enrichment Systems")), "",
    "commodity dropped — Inara plots would record no intent at all");
});
t("the handler reads dataset.comm, not the title text", () => {
  const h = html.split("\n").find((l) => l.includes("inara\\.cz/i.test"));
  assert.match(h, /arm\(a\.dataset\.comm/,
    "deriving from display copy is what data-station taught us not to do");
});
t("an ampersand in a commodity name cannot break the attribute", () => {
  const h = renderInaraLink('Bad" onclick="x');
  assert.ok(!/onclick="x/.test(h), "attribute injection via commodity name");
});

console.log("\nSTATE — arming survives the page load, or the value is silently lost");
t("★ the commodity is stored in localStorage, not a variable", () => {
  // The pilot leaves for Inara and comes back: that is a page load. An in-memory
  // commodity would be gone and would post as "" without complaint.
  assert.match(html, /var KEY="ob_inaraTx", CKEY="ob_inaraTxComm"/);
  assert.match(html, /function armComm\(c\)\{[^}]*localStorage\.setItem\(CKEY,c\)/);
});
t("every path that clears the arm also clears the commodity", () => {
  const clear = html.split("\n").find((l) => l.includes("function clear()"));
  const tick = html.split("\n").find((l) => l.includes("localStorage.removeItem(KEY); }catch(e){} dropComm();"));
  const sent = html.split("\n").find((l) => l.includes('btn.textContent="✓ SENT"'));
  assert.match(clear, /dropComm\(\)/, "clear() leaves a stale commodity");
  assert.ok(tick, "the expiry path leaves a stale commodity");
  assert.match(sent, /dropComm\(\)/, "a sent transmit leaves a stale commodity");
});
t("transmit posts the commodity and NO station", () => {
  // ⚠ Select on getComm(), NOT on the JSON.stringify prefix. The first draft matched
  // `{system:sys,commodity:` — which copyNav() (the SUPPLIER path) also matches, and
  // that one correctly DOES send a station. So the test failed against the right code
  // for the wrong reason. A selector loose enough to hit two call sites is not a test
  // of either.
  const line = html.split("\n").find((l) => l.includes("commodity:getComm()"));
  assert.ok(line, "transmit does not send a commodity");
  assert.ok(!/station:/.test(line),
    "a station on this path would be invented — the board never sees Inara's page");
});

console.log("\n★★ THE ONE THAT MATTERS — both paths must record the SAME key");
t("★★ Inara display name and drawer key normalize identically", () => {
  // page normalizer (_strip) vs the server's, applied to the two paths' inputs.
  const _strip = (s) => String(s == null ? "" : s).toLowerCase().replace(/[^a-z0-9]/g, "");
  const srvLine = NAV.split("\n").find((l) => l.includes("const commodity ="));
  assert.ok(/toLowerCase\(\)\.replace\(\/\[\^a-z0-9_\]\/g, ""\)/.test(srvLine), "server normalizer changed shape");
  const srvNorm = (v) => String(v || "").toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 40);

  for (const [display, key] of [
    ["Titanium", "titanium"],
    ["Land Enrichment Systems", "landenrichmentsystems"],
    ["CMM Composite", "cmmcomposite"],
    ["H.N. Shock Mount", "hnshockmount"],
    ["Agri-Medicines", "agrimedicines"],
    ["Rockforth Fertiliser", "rockforthfertiliser"],
  ]) {
    // Inara path posts the DISPLAY name; the drawer path posts the KEY.
    assert.equal(srvNorm(display), srvNorm(key),
      `two spellings of ${display} would land in intent[] as different commodities`);
    assert.equal(_strip(display), key, `page normalizer disagrees for ${display}`);
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
