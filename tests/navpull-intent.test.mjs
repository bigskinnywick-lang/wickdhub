// Proof for the 2026-08-17 intent sidecar. Run: node tests/navpull-intent.test.mjs
//
// TWO claims are being defended here, and only the first is about a feature.
//
//  1. a paired DEVICE gets {intent, recorded} alongside the nav target
//  2. ★★ a LEGACY-KEY caller gets the pre-2026-08-17 payload BYTE FOR BYTE
//
// (2) is the load-bearing one. The legacy shared key is a literal in load.py in a
// PUBLIC repo, so `?key=&cmdr=` answers for any commander a stranger can name.
// It already leaks a nav target; intent would add what he is hauling and where he
// is taking it. No credential is exposed either way — the harm is that a public
// key starts answering a materially more useful question.
//
// ⚠ HOW THIS FILE WAS WRONG THE FIRST TIME, kept because the lesson is the point.
// The gate started life inline in the handler, and this file "tested" it with a
// hand-written mirror of the same logic. The behavioural assertions below all
// passed — against the copy. Mutating the real navpull.js changed nothing, and two
// of three mutations went undetected, one of them the empty-station bug this gate
// exists to prevent. So the gate was extracted into an exported pure function and
// is now IMPORTED here. A control that cannot see the code it guards is decoration.
import assert from "node:assert/strict";
import fs from "node:fs";
import { intentPayload } from "../functions/ingest/navpull.js";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}

const SRC = fs.readFileSync("functions/ingest/navpull.js", "utf8");

// Assemble the response exactly as the handler does, around the REAL gate.
function projectNav({ via, navSystem, navTs, intentStore }) {
  const sidecar = (via === "device" && navSystem)
    ? intentPayload(via, navSystem, navTs, intentStore)
    : intentPayload(via, navSystem, navTs, intentStore);
  const out = { ok: true, system: navSystem, ts: navTs, now: 123, act: null, latest: null, channel: "beta", settings: {} };
  if (sidecar) { out.intent = sidecar.intent; out.recorded = sidecar.recorded; }
  return out;
}

const TS = 1755500000000;
const STORE = [
  { system: "Nyx", commodity: "titanium", station: "Zoline's Inheritance", ts: TS },
  { system: "Nyx", commodity: "steel", station: "", ts: TS - 90000 },   // the Inara-path shape
];
const dev = (o) => projectNav({ via: "device", navSystem: "Nyx", navTs: TS, intentStore: STORE, ...o });

console.log("\nWIRING — the handler must actually use the gate it exports");
t("the handler calls intentPayload rather than re-implementing it", () => {
  assert.match(SRC, /sidecar = intentPayload\(a\.via, navSystem, navTs, rows\)/,
    "the handler has drifted away from the tested function — the original defect, returning");
});
t("intent/recorded reach the response only via the sidecar", () => {
  assert.match(SRC, /if \(sidecar\) \{ out\.intent = sidecar\.intent; out\.recorded = sidecar\.recorded; \}/);
});

console.log("\nDEVICE — the pilot's own paired plugin");
t("a device caller gets the commodity and the station", () => {
  const o = dev();
  assert.equal(o.intent.commodity, "titanium");
  assert.equal(o.intent.station, "Zoline's Inheritance");
});
t("★ recorded[] names exactly what is actually held", () => {
  assert.deepEqual(dev().recorded, ["system", "commodity", "station"]);
});
t("★★ an EMPTY station is absent from recorded[] — not reported as a station", () => {
  // The Inara path records no station, and for one day in August the supplier path
  // recorded "" too. A consumer reading intent.station ?? "" would call that
  // "no station here". recorded[] is what makes that impossible.
  const o = dev({ navTs: TS - 90000 });
  assert.deepEqual(o.recorded, ["system", "commodity"]);
  assert.ok(!("station" in o.intent), "an empty station leaked into the payload as a value");
});
t("no matching intent row still yields a well-formed answer", () => {
  const o = dev({ navTs: TS - 1 });
  assert.deepEqual(o.recorded, ["system"]);
  assert.deepEqual(o.intent, {});
});
t("no nav target at all: recorded is empty, not absent", () => {
  const o = projectNav({ via: "device", navSystem: null, navTs: 0, intentStore: STORE });
  assert.deepEqual(o.recorded, []);
});

console.log("\n★★ LEGACY — the public key must learn NOTHING new");
const BASE_KEYS = ["ok", "system", "ts", "now", "act", "latest", "channel", "settings"];
t("★★ NEGATIVE: a legacy caller gets no intent field", () => {
  const o = projectNav({ via: "legacy", navSystem: "Nyx", navTs: TS, intentStore: STORE });
  assert.ok(!("intent" in o), "intent leaked to a caller holding the PUBLIC shared key");
});
t("★★ NEGATIVE: a legacy caller gets no recorded field either", () => {
  const o = projectNav({ via: "legacy", navSystem: "Nyx", navTs: TS, intentStore: STORE });
  assert.ok(!("recorded" in o), "recorded[] tells a stranger a station exists, even without naming it");
});
t("★★ the legacy payload is byte-for-byte the pre-change shape", () => {
  const o = projectNav({ via: "legacy", navSystem: "Nyx", navTs: TS, intentStore: STORE });
  assert.deepEqual(Object.keys(o).sort(), [...BASE_KEYS].sort(),
    "an old plugin's payload changed — that is a compatibility break as well as a leak");
});
t("NEGATIVE: no station string appears anywhere in a legacy response", () => {
  const s = JSON.stringify(projectNav({ via: "legacy", navSystem: "Nyx", navTs: TS, intentStore: STORE }));
  for (const leak of ["Zoline", "titanium", "steel"]) {
    assert.ok(!s.includes(leak), leak + " reachable with the public key");
  }
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
