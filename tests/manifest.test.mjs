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
  MANIFEST, MANIFEST_VERSION, project, fieldsFor, unreadableFor, isProhibited, isDeclared,
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
  // own, but LOCAL-resident — declared in the manifest, deliberately unreachable.
  // Present in the bag on purpose: this is the case where a future backup lane
  // wires the gather step up before anyone re-reads the sharing decision.
  honkIndex: { "Col 285 Sector BU-O b7-3": { ts: 1 } },
  favourites: [{ name: "the yard", station: "Collora's Progress" }],
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
t("residence is one of the three declared values, or absent (= board)", () => {
  for (const m of MANIFEST) {
    if ("residence" in m) {
      assert.ok(["board", "local", "both"].includes(m.residence), `bad residence on ${m.key}`);
    }
  }
});
t("a local-resident field is unreachable by scope", () => {
  // Residence is descriptive; `scope` is what gates. This asserts the two agree,
  // so a row cannot claim to live only on the pilot's machine while also being
  // emitable from the board.
  for (const m of MANIFEST) {
    if (m.residence === "local") assert.equal(m.scope, null, `${m.key} says it never leaves the machine, but has a scope`);
  }
});

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
t("★ NEGATIVE: a LOCAL-resident field cannot leak, at any scope", () => {
  // The honk index is a map of everywhere this pilot has ever flown. It is OWN
  // data — but it lives on his machine and has never been sent anywhere, and the
  // backup lane that would change that is gated on INGEST_LEGACY_OFF=1.
  //
  // ⚠ THIS TEST GUARDS ONE DIRECTION ONLY. It proves the BOARD will not emit
  // these. It cannot prove the plugin does not write them somewhere it should
  // not, because that path never calls project(). The seal covers the outbound
  // API, not the pilot's own disk. See the residence note in manifest.js.
  for (const scopes of [[SCOPE_OWN], [SCOPE_SQUAD_AGG], SCOPES, []]) {
    const o = project(KITCHEN_SINK, scopes);
    for (const k of ["honkIndex", "favourites"]) {
      assert.ok(!(k in o), `${k} leaked at scope [${scopes}] — it is declared, not shared`);
    }
  }
});
t("★ NEGATIVE: no cumulative OWN history reaches a squad aggregate", () => {
  // The squad tier is aggregates only, and every aggregate today is a count over
  // present-tense state. A movement history behind an aggregate is still a
  // movement history — 'where has CMDR X been' is 'where is CMDR X' with a
  // timeline attached, and that stays closed at every tier.
  const sq = project(KITCHEN_SINK, [SCOPE_SQUAD_AGG]);
  assert.ok(!JSON.stringify(sq).includes("Col 285 Sector BU-O b7-3"),
    "a honked system name surfaced through the squad projection");
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
t("project tolerates a null source and still honours the contract", () => {
  const o = project(null, SCOPES);
  assert.equal(Object.keys(o).length, fieldsFor(SCOPES).length);
});
t("0 is a real value and must survive", () => {
  assert.equal(project({ fuelPct: 0 }, SCOPES).fuelPct, 0);
});

console.log("\n★★ THE CONTRACT — one meaning per silence (the rig caught this live)");
t("★ available[] and data{} carry the SAME keys — no over-promising", () => {
  const o = project({ system: "Sol" }, SCOPES);
  const avail = fieldsFor(SCOPES).map((m) => m.key).sort();
  assert.deepEqual(Object.keys(o).sort(), avail,
    "the endpoint tells consumers to trust available[]; it must not list 17 and deliver 12");
});
t("★★ NEGATIVE: an empty alerts lane is [] — never absent", () => {
  const o = project({ system: "Sol" }, SCOPES);
  assert.deepEqual(o.alerts, [],
    "`data.alerts ?? []` reads ABSENT as EMPTY, which reads as 'no threats' — the wrong-way failure");
});
t("empty containers match the declared shape", () => {
  const o = project({}, SCOPES);
  assert.deepEqual(o.intent, [], "list");
  assert.deepEqual(o.cargoManifest, {}, "map");
  assert.equal(o.system, null, "scalar");
});

console.log("\n★★ THE THIRD STATE — 'could not look' is not 'nothing there'");
t("★ an UNREADABLE field is withheld, not faked as empty", () => {
  const o = project({ system: "Sol" }, SCOPES, ["alerts"]);
  assert.ok(!("alerts" in o),
    "a convincing empty array here would tell a flying assistant it is safe when we simply could not check");
});
t("...and it is named, so the consumer knows why", () => {
  assert.deepEqual(unreadableFor(SCOPES, ["alerts"]), ["alerts"]);
});
t("unreadable never invents a field the scopes did not permit", () => {
  assert.deepEqual(unreadableFor(SCOPES, ["memberDiscord", "playerChat"]), []);
});
t("NEGATIVE: unreadable cannot be used to smuggle a prohibited key into the envelope", () => {
  assert.deepEqual(unreadableFor(SCOPES, ["sealedAssociation"]), []);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
