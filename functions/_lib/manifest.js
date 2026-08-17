// OB-2 DATA MANIFEST — the machine-readable source of truth.
//
// Spec: secondbrain `02 Projects/Elite Dangerous/Blades Data Manifest (OB-2).md`
// Survey: `Blades DevNotes — Architecture & Data Inventory.md`
//
// ─── WHY THIS IS CODE AND NOT A DOCUMENT ─────────────────────────────────────
// A policy written in prose drifts away from 27 independently-gated Functions
// inside a month — and this project has already shipped eight false user-facing
// claims by trusting memory over code.
//
// So the emitter reads THIS. `project()` can only return fields declared here.
// An undeclared field cannot leave the building, because there is nothing to
// copy it from. Adding one to an API response is therefore impossible without a
// reviewable diff that states its class and its sharing decision.
//
// That property is the whole point: a new operator cannot accidentally widen
// what is shared. It is not a rule someone has to read and honour.
//
// ─── THE FOUR STATES (Adam's own words, used literally) ──────────────────────
//   collected  — is it captured at all
//   protected  — stored, but restricted; who may read it
//   prohibited — must NEVER be captured, stored, transmitted, or put in a model
//   shared     — may cross a boundary, and explicitly to whom
//
// ─── THE THREE POPULATIONS ───────────────────────────────────────────────────
//   own          the pilot's own data. Moving it between their own machines is
//                not a disclosure. No consent debt. Most of what COVAS wants.
//   squad        other members' data. Governed by OB-1 — but OB-1 covers a
//                BOARD, not an agent. v1 emits aggregates only, never a name.
//   third-party  people who never consented to anything. PROHIBITED outright.
//
// ─── THE AGENT RULE ──────────────────────────────────────────────────────────
//   An agent may answer about the pilot holding the token, and aggregates about
//   everyone else. "Where is CMDR X" stays closed at every permission level —
//   that is the question OB-1 never contemplated, because a board displays and
//   an agent infers and speaks.

export const MANIFEST_VERSION = "OB-2/1";

// scope values a caller may hold. Ordered loosest to tightest for clarity only;
// there is no implicit inheritance — a field lists exactly who may see it.
export const SCOPE_OWN = "own";
export const SCOPE_SQUAD_AGG = "squad:aggregate";

/**
 * Every field an agent may ever be handed. Anything not in this list does not
 * exist as far as the projector is concerned.
 *
 * key       — the name it is emitted under
 * cls       — own | squad | third-party
 * scope     — which caller scope unlocks it (null = never emitted)
 * from      — where the value is read from, for humans tracing it
 * note      — why it is classified this way, when that is not obvious
 */
export const MANIFEST = [
  // ── OWN: live cockpit state, from this pilot's own plugin heartbeat ───────
  { key: "system",    cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.sys" },
  { key: "ship",      cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.ship" },
  { key: "shipName",  cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.shipName" },
  { key: "status",    cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.status" },
  { key: "fuelPct",   cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.fuelPct" },
  { key: "cargo",     cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.cargo" },
  { key: "cargoCap",  cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.cargoCap" },
  { key: "telemetryTs", cls: "own", scope: SCOPE_OWN, from: "plugin:telemetry.ts" },

  // ── OWN: alerts. The hostile-hail VERDICT, not the corpus it was derived
  // from. npc-tokens.log never crosses a machine boundary — it exists to tune a
  // matcher, not to feed a model.
  { key: "alerts", cls: "own", scope: SCOPE_OWN, from: "plugin:alerts.alerts[]",
    note: "derived judgment about this pilot's own situation; already truncated at the plugin" },

  // ── OWN: newly collected 2026-08-16. Previously parsed and thrown away.
  { key: "cargoManifest", cls: "own", scope: SCOPE_OWN, from: "sq:onyx:cargo:{cmdr}.items",
    note: "the plugin only ever read total tonnage; what is IN the hold was never looked at" },
  { key: "intent", cls: "own", scope: SCOPE_OWN, from: "sq:onyx:intent:{cmdr}.recent[]",
    note: "which commodity was searched before plotting. Lived in browser srcCache and died there. Hoard now, use later — do NOT build a feature on it" },

  // ── OWN: this pilot's own claims and carrier. Already squad-visible.
  { key: "myClaims",  cls: "own", scope: SCOPE_OWN, from: "claim:* where architect == me" },
  { key: "myCarrier", cls: "own", scope: SCOPE_OWN, from: "carrier:* where owner == me" },

  // ── SQUAD: aggregates only. Integers the public storefront already shows.
  { key: "pilotsOnline",   cls: "squad", scope: SCOPE_SQUAD_AGG, from: "count(presence:*)" },
  { key: "systemsActive",  cls: "squad", scope: SCOPE_SQUAD_AGG, from: "count(distinct build.system)" },
  { key: "buildProgress",  cls: "squad", scope: SCOPE_SQUAD_AGG, from: "raven project totals",
    note: "tonnage remaining / percent complete for the active build — a number about a PLACE, not a person" },
  { key: "siteRequirements", cls: "squad", scope: SCOPE_SQUAD_AGG, from: "sq:onyx:req:{marketId}.commodities",
    note: "what a construction site still needs. About a place, not a pilot" },

  // ── SQUAD, NAMED: collected, protected, NOT shared in v1. ────────────────
  // Emitting any of these requires an OB-1 amendment with an opt-in preference
  // defaulting OFF, a version bump and one-time notice. scope:null means the
  // projector has no way to emit them at all.
  { key: "memberPresenceNamed", cls: "squad", scope: null, from: "presence:{cmdr}",
    note: "'where is CMDR X' — the question OB-1 never contemplated" },
  { key: "memberLoadout",       cls: "squad", scope: null, from: "loadout:{cmdr}" },
  { key: "memberCarrier",       cls: "squad", scope: null, from: "carrier:{marketId}" },
  { key: "memberContributions", cls: "squad", scope: null, from: "raven stats.cmdrs{}",
    note: "OB-1 credit_contributions governs DISPLAY to members, not agent access" },
  { key: "memberDiscord",       cls: "squad", scope: null, from: "member:{email}.discord",
    note: "OB-1 link_discord_public defaults OFF; a handle can deanonymize a CMDR" },
  { key: "memberEmail",         cls: "squad", scope: null, from: "cmdrlink key name",
    note: "never emitted to any client, at any tier" },
  { key: "memberStatus",        cls: "squad", scope: null, from: "member:{email}.status" },

  // ── PROHIBITED. Not 'protected' — these must never be captured, stored,
  // transmitted, or placed in a model context. scope:null AND prohibited:true.
  { key: "playerChat", cls: "third-party", scope: null, prohibited: true,
    from: "journal ReceiveText, non-npc channels",
    note: "other commanders never consented to anything; some of it is private correspondence" },
  { key: "systemChatter", cls: "third-party", scope: null, prohibited: true,
    from: "journal ReceiveText channel=starsystem",
    note: "17,723 events measured — broadcast by strangers, not ours to keep" },
  { key: "playerHandles", cls: "third-party", scope: null, prohibited: true,
    from: "recovered from journals for voice casting",
    note: "the casting map stays on the rig; never persisted anywhere that syncs" },
  { key: "npcTokenLog", cls: "third-party", scope: null, prohibited: true,
    from: "plugin npc-tokens.log",
    note: "exists to tune a matcher, not to feed a model. Never leaves the machine that wrote it" },
  { key: "rigHardware", cls: "own", scope: null, prohibited: true, from: "rig:{email}",
    note: "OB-1 §III real-world data: volunteered, optional, never public, destroyed on departure. An agent is none of those" },
  { key: "carrierPosition", cls: "own", scope: null, prohibited: true, from: "n/a",
    note: "flagged sensitive in the founding spec; the abandoned EDColony path leaked exactly this" },
  { key: "sealedAssociation", cls: "own", scope: null, prohibited: true, from: "n/a",
    note: "AI Companion Notes holds a sealed item. Not sensitive because of a regulation — sensitive because Adam said so, and the manifest has to be able to express that" },
];

const BY_KEY = new Map(MANIFEST.map((m) => [m.key, m]));

export function fieldsFor(scopes) {
  const held = new Set(Array.isArray(scopes) ? scopes : [scopes]);
  return MANIFEST.filter((m) => !m.prohibited && m.scope && held.has(m.scope));
}

export const isProhibited = (key) => !!(BY_KEY.get(key) || {}).prohibited;
export const isDeclared = (key) => BY_KEY.has(key);

/**
 * THE CHOKE POINT. Build a response by copying declared fields out of `source`.
 *
 * Note the direction: we iterate the MANIFEST and pull from the source, never
 * iterate the source and filter. A filter forgets; a whitelist cannot. If a new
 * field appears in `source` tomorrow it simply does not come out, which is the
 * correct default for data nobody has classified yet.
 */
export function project(source, scopes) {
  const out = {};
  for (const m of fieldsFor(scopes)) {
    if (source && Object.prototype.hasOwnProperty.call(source, m.key) && source[m.key] !== undefined) {
      out[m.key] = source[m.key];
    }
  }
  return out;
}
