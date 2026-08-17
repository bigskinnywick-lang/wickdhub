// The manifest is the seal. These tests are what make that true rather than aspirational.
//
// Run: node tests/manifest.test.mjs
//
// ─── WHY ─────────────────────────────────────────────────────────────────────
// OB-2 says an operator must not be able to accidentally widen what is shared.
// That claim rests entirely on `project()` being a WHITELIST — iterating the
// manifest and pulling — rather than a filter over whatever the code happened to
// assemble. A filter forgets a new field; a whitelist cannot.
//
// So the load-bearing tests here are the negative ones: given a data bag that
// contains squad-named data, prohibited data, and fields nobody has classified
// at all, prove that NONE of it comes out. If those three ever go green while
// the projection is broken, this file is decoration.
import assert from "node:assert/strict";
import {
  MANIFEST, MANIFEST_VERSION, project, fieldsFor, isProhibited, isDeclared,
  SCOPE_OWN, SCOPE_SQUAD_AGG,
} from "../functions/_lib/manifest.js";

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log("  ok   " + name); pass++; }
  catch (e) { console.log("  FAIL " + name + "\n         " + e.message); fail++; }
}

const SCOPES = [SCOPE_OWN, SCOPE_SQUAD_AGG];

// A deliberately over-full bag: everything the gather step could plausibly hold,
// plus things it must never emit, plus something entirely unknown.
const KITCHEN_SINK = {
  // own — should come out
  system: "Col 285 Sector BU-O b7-3", fuelPct: 62, cargo: 480, cargoCap: 790,
  alerts: [{ id: "x", level: "critical", msg: "PIRATE INBOUND" }],
  cargoManifest: { titanium: 200 }, intent: [{ commodity: "titanium" }],
  myClaims: [{ system: "X" }], myCarrier: { callsign: "ABC-123" },
  // squad aggregate — should come out
  pilotsOnline: 3, systemsActive: 9, buildProgress: { remaining: 5690 },
  siteRequirements: { titanium: 1200 },
  // squad NAMED — must NOT come out
  memberPresenceNamed: { cmdr: "Templar57", system: "Sol" },
  memberLoadout: { cmdr: "XELDUS", ship: "Type-9" },
  memberContributions: { Templar57: 4000 },
  memberDiscord: "templar#1234",
  memberEmail: "someone@example.com",
  memberStatus: "MIA",
  memberCarrier: { callsign: "ZZZ-999" },
  // prohibited — must NOT come out
  playerChat: ["hey are you hauling?"],
  systemChatter: ["o7"],
  playerHandles: ["Templar57", "XELDUS"],
  npcTokenLog: ["$pirate_attack;"],
  rigHardware: { gpu: "RTX 2070" },
  carrierPosition: { system: "Sol" },
  sealedAssociation: { a: "b" },
  // never classified at all — the case a filter would let through
  someNewFieldNobodyClassified: "leak",
  __proto__: undefined,
};

console.log("\nSTRUCTURE");
t("every entry has a key and a class", () => {
  for (const m of MANIFEST) {
    assert.ok(m.key, "missing key");
    assert.ok(["own", "squad", "third-party"].includes(m.cls), `bad cls on ${m.key}`);
  }
});
t("keys are unique", () => {
  const s = new Set(MANIFEST.map((m) => m.key));
  assert.equal(s.size, MANIFEST.length);
});
t("every prohibited entry is also unreachable by scope", () => {
  for (const m of MANIFEST) if (m.prohibited) assert.equal(m.scope, null, `${m.key} is prohibited but has a scope`);
});
t("every third-party entry is prohibited — no exceptions", () => {
  for (const m of MANIFEST) {
    if (m.cls === "third-party") assert.equal(m.prohibited, true, `${m.key} is third-party but not prohibited`);
  }
});
t("the manifest is versioned", () => assert.match(MANIFEST_VERSION, /^OB-2\//));

console.log("\nPROJECTION — what SHOULD come out");
const out = project(KITCHEN_SINK, SCOPES);
t("own live telemetry is emitted", () => {
  assert.equal(out.system, "Col 285 Sector BU-O b7-3");
  assert.equal(out.fuelPct, 62);
});
t("the alert VERDICT is emitted", () => assert.equal(out.alerts.length, 1));
t("newly-hoarded own data is emitted (cargo manifest + search intent)", () => {
  assert.deepEqual(out.cargoManifest, { titanium: 200 });
  assert.equal(out.intent.length, 1);
});
t("squad AGGREGATES are emitted", () => {
  assert.equal(out.pilotsOnline, 3);
  assert.equal(out.systemsActive, 9);
  assert.equal(out.siteRequirements.titanium, 1200);
});

console.log("\n★ PROJECTION — what must NEVER come out");
t("NEGATIVE: no squad-NAMED field escapes", () => {
  for (const k of ["memberPresenceNamed", "memberLoadout", "memberContributions",
                   "memberDiscord", "memberEmail", "memberStatus", "memberCarrier"]) {
    assert.ok(!(k in out), `${k} leaked — 'where is CMDR X' must stay closed at every tier`);
  }
});
t("NEGATIVE: no PROHIBITED field escapes", () => {
  for (const k of ["playerChat", "systemChatter", "playerHandles", "npcTokenLog",
                   "rigHardware", "carrierPosition", "sealedAssociation"]) {
    assert.ok(!(k in out), `${k} leaked — prohibited means never, not 'protected'`);
  }
});
t("★ NEGATIVE: an UNCLASSIFIED field cannot leak", () => {
  assert.ok(!("someNewFieldNobodyClassified" in out),
    "this is the whole argument for a whitelist: a filter forgets, a whitelist cannot");
});
t("NEGATIVE: no raw player identity anywhere in the serialized output", () => {
  const s = JSON.stringify(out);
  for (const h of ["Templar57", "XELDUS", "someone@example.com", "templar#1234"]) {
    assert.ok(!s.includes(h), `${h} appears in the agent response`);
  }
});

console.log("\nSCOPES");
t("holding only OWN yields no squad aggregates", () => {
  const o = project(KITCHEN_SINK, [SCOPE_OWN]);
  assert.ok("system" in o);
  assert.ok(!("pilotsOnline" in o));
});
t("holding NO scope yields nothing at all", () => {
  assert.deepEqual(project(KITCHEN_SINK, []), {});
});
t("an unknown scope grants nothing", () => {
  assert.deepEqual(project(KITCHEN_SINK, ["squad:named"]), {});
});
t("fieldsFor never advertises a prohibited field", () => {
  for (const m of fieldsFor(SCOPES)) assert.ok(!m.prohibited);
});

console.log("\nHELPERS");
t("isProhibited / isDeclared agree with the table", () => {
  assert.equal(isProhibited("playerChat"), true);
  assert.equal(isProhibited("system"), false);
  assert.equal(isDeclared("system"), true);
  assert.equal(isDeclared("someNewFieldNobodyClassified"), false);
});
t("project tolerates a null source", () => assert.deepEqual(project(null, SCOPES), {}));
t("undefined values are omitted rather than emitted as null", () => {
  const o = project({ system: undefined, fuelPct: 0 }, SCOPES);
  assert.ok(!("system" in o));
  assert.equal(o.fuelPct, 0, "0 is a real value and must survive");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
