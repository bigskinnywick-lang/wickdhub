/* Blades — MY DASHBOARD live telemetry tile row + ALERTS strip (shared, MY STATS page).
   Bricks 2 and 3 of the Commander Dashboard. Renders a strip of live tiles — current system,
   ship, fuel %, cargo, flight state — fed by the Blades Registrar plugin's heartbeat
   (/ingest/navpull -> KV plugin:telemetry -> /blades/api/telemetry). Design rules it honors:
     • LIVENESS + FAIL-TO-GREY: shows "updated Ns ago" when live; if the plugin isn't
       reporting (stale/no data) the tiles go GREY and read "—" rather than showing a stale
       position as if it were current.
     • THRESHOLD GLOW: the fuel tile glows amber when fuel is low.
   BRICK 3 — ALERTS: the same poll carries the pilot's alert lane (pirate scan, fuel low, …).
   A new alert pulses the strip red/amber and sounds a KLAXON synthesized in-page (no audio
   file), with a per-device mute in localStorage like the theme dials, and a TEST button that
   doubles as the browser's required first-gesture to arm audio. Only the newest unseen alerts
   ever sound — a re-poll of the same log is silent, and the backlog present at page load is
   marked seen without a peep.
   Self-contained (own CSS); mounts only for a signed-in, CMDR-bound pilot; polls every ~5s
   while visible, pauses when the tab is hidden. */
(function () {
  var POLL_MS = 5000, STALE_MS = 30000, FUEL_LOW = 25, FUEL_CRIT = 10;
  var TEL = null, tsAgeTimer = null, lastTs = 0;
  // b3.16: the card used to accumulate — 4 stacked up during one evening's testing. Show
  // fewer, and let them expire from the STRIP after a while. The KV ring (rolling 20, 6h TTL)
  // is deliberately left alone: the goal is a quiet card, not a lost record — that history is
  // how the last several bugs were diagnosed.
  var ALERTS_SHOW = 4, ALERT_TTL_MS = 15 * 60 * 1000;
  var FLASH_MS = 6000, MUTE_KEY = "ob_alarm_mute", TONE_KEY = "ob_alarm_tone";
  var LAST_ALERTS = [];
  var SEEN = null, AC = null, audioBlocked = false, flashTimer = null;

  // Ship code -> display name (subset; unknown codes get title-cased).
  var SHIP = {
    sidewinder:"Sidewinder",eagle:"Eagle Mk II",hauler:"Hauler",adder:"Adder",viper:"Viper Mk III",
    viper_mkiv:"Viper Mk IV",cobramkiii:"Cobra Mk III",cobramkiv:"Cobra Mk IV",cobramkv:"Cobra Mk V",
    type6:"Type-6 Transporter",dolphin:"Dolphin",diamondback:"Diamondback Scout",diamondbackxl:"Diamondback Explorer",
    empire_courier:"Imperial Courier",independant_trader:"Keelback",asp_scout:"Asp Scout",vulture:"Vulture",
    asp:"Asp Explorer",federation_dropship:"Federal Dropship",type7:"Type-7 Transporter",typex:"Alliance Chieftain",
    federation_dropship_mkii:"Federal Assault Ship",empire_trader:"Imperial Clipper",typex_2:"Alliance Crusader",
    typex_3:"Alliance Challenger",federation_gunship:"Federal Gunship",krait_light:"Krait Phantom",
    krait_mkii:"Krait Mk II",mamba:"Mamba",python:"Python",python_nx:"Python Mk II",ferdelance:"Fer-de-Lance",
    type9:"Type-9 Heavy",type9_military:"Type-10 Defender",belugaliner:"Beluga Liner",orca:"Orca",
    anaconda:"Anaconda",federation_corvette:"Federal Corvette",cutter:"Imperial Cutter",type8:"Type-8 Transporter",
    mandalay:"Mandalay",corsair:"Corsair",panthermkii:"Panther Clipper Mk II"
  };
  function shipName(t) { t = String(t || "").toLowerCase(); if (SHIP[t]) return SHIP[t]; if (!t) return "—";
    return t.split("_").map(function (w) { return w ? w.charAt(0).toUpperCase() + w.slice(1) : w; }).join(" "); }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function fmt(n) { return Number(n || 0).toLocaleString("en-US"); }
  function agoStr(ms) { if (ms == null) return ""; var s = Math.round(ms / 1000);
    if (s < 60) return s + "s ago"; var m = Math.round(s / 60); if (m < 60) return m + "m ago"; return Math.round(m / 60) + "h ago"; }

  // Age is measured from a LOCAL reference captured at each poll, never by subtracting the
  // server's epoch `ts` from the browser clock — a browser whose clock is skewed >30s from the
  // server would otherwise flip the strip to grey one second after load and never recover.
  // markLocal() freezes the server-reported age + the local time we saw it; liveAge() then adds
  // only the CLIENT-measured elapsed time, which is immune to any absolute clock offset.
  function markLocal(d) { if (d) { d._ageAt = (typeof d.ageMs === "number") ? d.ageMs : null; d._localAt = Date.now(); } }
  function liveAge(d) {
    if (!d || d._ageAt == null) return null;
    return d._ageAt + Math.max(0, Date.now() - d._localAt);
  }

  function injectCss() {
    if (document.getElementById("obTelStyle")) return;
    var st = document.createElement("style"); st.id = "obTelStyle";
    st.textContent = [
      "#obTelStrip{margin:14px 0 4px;border:1px solid var(--accent-dim,#a24d08);background:color-mix(in srgb,var(--accent,#ff7a12) 5%,var(--panel,#140d07));border-radius:var(--radius,12px);overflow:hidden}",
      "#obTelStrip .ot-head{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line,#3a2410);font-family:var(--font-head,'Orbitron',sans-serif);font-size:10.5px;letter-spacing:2px;color:var(--accent-bright,#ffb057)}",
      "#obTelStrip .ot-live{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-size:9.5px;letter-spacing:1.5px;color:var(--muted,#b98a52)}",
      // BACK TO GAME — FIXED, not in the strip (moved 2026-08-12, Adam's call). Its whole job
      // is "I am done here, put me back", and that is exactly the moment you are least likely
      // to be scrolled to the top of the board. Anchored top-right because the lower-right is
      // the zoom control's lane.
      // ⚠ SHARED LANE: the ⚑ TEST TRACK badge (_shell/testpilot.js) sits directly below at
      // top:78px. Move either one and check the other.
      "#obBackFix{position:fixed;top:44px;right:12px;z-index:99998;cursor:pointer;user-select:none;border:1px solid var(--accent-dim,#a24d08);background:rgba(28,17,9,.92);border-radius:7px;padding:5px 10px;font-family:var(--font-head,'Orbitron',sans-serif);font-size:9.5px;letter-spacing:1.5px;color:var(--muted,#b98a52);transition:.15s}",
      "#obBackFix:hover{border-color:var(--accent,#ff7a12);color:var(--accent-bright,#ffb057)}",
      "#obBackFix[disabled]{opacity:.4;cursor:not-allowed;border-color:var(--line,#3a2410)}",
      "#obBackFix.sent{border-color:var(--ok,#5fbf7f);color:var(--ok,#5fbf7f)}",
      "#obTelStrip .ot-dot{width:8px;height:8px;border-radius:50%;background:var(--good,#57e0a0);box-shadow:0 0 8px var(--good,#57e0a0)}",
      "#obTelStrip.stale .ot-dot{background:var(--muted,#7a6a55);box-shadow:none}",
      "#obTelStrip .ot-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:1px;background:var(--line,#3a2410)}",
      "#obTelStrip .ot-tile{background:var(--panel,#140d07);padding:11px 14px;min-height:56px}",
      "#obTelStrip .ot-lbl{font-family:var(--font-head,'Orbitron',sans-serif);font-size:9px;letter-spacing:1.5px;color:var(--muted,#b98a52);text-transform:uppercase}",
      "#obTelStrip .ot-val{font-family:var(--font-head,'Orbitron',sans-serif);font-size:17px;color:var(--accent-bright,#ffb057);margin-top:5px;line-height:1.15;word-break:break-word}",
      "#obTelStrip .ot-sub{font-size:10px;color:var(--muted,#b98a52);margin-top:2px}",
      "#obTelStrip.stale .ot-val{color:var(--muted,#7a6a55)}",
      "#obTelStrip.stale{opacity:.72}",
      // fuel threshold glow — amber when low, red when critical (only while live)
      "#obTelStrip .ot-tile.warn .ot-val{color:var(--warn,#f0a828)}",
      "#obTelStrip .ot-tile.warn{box-shadow:inset 0 0 0 1px var(--warn,#f0a828);animation:otPulse 1.8s ease-in-out infinite}",
      "#obTelStrip .ot-tile.crit .ot-val{color:var(--bad,#e0574a)}",
      "#obTelStrip .ot-tile.crit{box-shadow:inset 0 0 0 1px var(--bad,#e0574a);animation:otPulse 1s ease-in-out infinite}",
      "@keyframes otPulse{0%,100%{background:var(--panel,#140d07)}50%{background:color-mix(in srgb,var(--warn,#f0a828) 12%,var(--panel,#140d07))}}",
      // ---- brick 3: alerts strip ----
      "#obAlertStrip{margin:8px 0 4px;border:1px solid var(--accent-dim,#a24d08);background:color-mix(in srgb,var(--accent,#ff7a12) 5%,var(--panel,#140d07));border-radius:var(--radius,12px);overflow:hidden}",
      "#obAlertStrip .oa-head{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line,#3a2410);font-family:var(--font-head,'Orbitron',sans-serif);font-size:10.5px;letter-spacing:2px;color:var(--accent-bright,#ffb057)}",
      "#obAlertStrip .oa-tools{margin-left:auto;display:inline-flex;gap:7px}",
      "#obAlertStrip .oa-btn{cursor:pointer;user-select:none;border:1px solid var(--accent-dim,#a24d08);background:var(--panel2,#1c1109);border-radius:7px;padding:4px 9px;font-family:var(--font-head,'Orbitron',sans-serif);font-size:9px;letter-spacing:1.5px;color:var(--muted,#b98a52);transition:.15s}",
      "#obAlertStrip .oa-btn:hover{border-color:var(--accent,#ff7a12);color:var(--accent-bright,#ffb057)}",
      "#obAlertStrip .oa-btn.muted{color:var(--bad,#e0574a);border-color:var(--bad,#e0574a)}",
      "#obAlertStrip .oa-list{list-style:none;margin:0;padding:0}",
      "#obAlertStrip .oa-item{display:flex;align-items:flex-start;gap:10px;padding:9px 14px;border-top:1px solid var(--line,#3a2410);font-size:12.5px;color:var(--fg,#f2d9b8)}",
      "#obAlertStrip .oa-item:first-child{border-top:0}",
      "#obAlertStrip .oa-led{width:9px;height:9px;border-radius:50%;margin-top:4px;flex:none;background:var(--muted,#7a6a55)}",
      "#obAlertStrip .oa-item.critical .oa-led{background:var(--bad,#e0574a);box-shadow:0 0 9px var(--bad,#e0574a)}",
      "#obAlertStrip .oa-item.critical .oa-msg{color:var(--bad,#e0574a);font-weight:600}",
      "#obAlertStrip .oa-item.warn .oa-led{background:var(--warn,#f0a828);box-shadow:0 0 9px var(--warn,#f0a828)}",
      "#obAlertStrip .oa-item.warn .oa-msg{color:var(--warn,#f0a828)}",
      "#obAlertStrip .oa-msg{flex:1;line-height:1.4;word-break:break-word}",
      "#obAlertStrip .oa-when{font-size:10px;color:var(--muted,#b98a52);white-space:nowrap;margin-top:2px}",
      "#obAlertStrip .oa-quiet{padding:11px 14px;font-size:11.5px;color:var(--muted,#b98a52)}",
      "#obAlertStrip .oa-blocked{display:none;padding:0 14px 10px;font-size:11px;color:var(--warn,#f0a828)}",
      "#obAlertStrip.blocked .oa-blocked{display:block}",
      // a fresh alert pulses the whole strip so a glance catches it even with the sound muted
      "#obAlertStrip.flash-critical{animation:oaFlashC .9s ease-in-out 6}",
      "#obAlertStrip.flash-warn{animation:oaFlashW 1.4s ease-in-out 4}",
      "@keyframes oaFlashC{0%,100%{box-shadow:0 0 0 0 rgba(224,87,74,0)}50%{box-shadow:0 0 22px 2px rgba(224,87,74,.55);border-color:var(--bad,#e0574a)}}",
      "@keyframes oaFlashW{0%,100%{box-shadow:0 0 0 0 rgba(240,168,40,0)}50%{box-shadow:0 0 18px 1px rgba(240,168,40,.45);border-color:var(--warn,#f0a828)}}",
      "@media (prefers-reduced-motion:reduce){#obAlertStrip.flash-critical,#obAlertStrip.flash-warn{animation:none;border-color:var(--bad,#e0574a)}}",
      /* ---- b3.9: WHOLE-PAGE flash. The strip pulse is easy to miss if you are heads-down
         in the game on another screen; this is meant to catch the corner of your eye from
         across the room. An edge-weighted vignette, NOT a full wash, so the board stays
         readable while it fires -- an alarm you cannot read through is a worse alarm.
         pointer-events:none is load-bearing: this sits above everything and must never
         eat a click. THREE pulses over ~3s = 1Hz, comfortably under the WCAG 2.3.1
         three-flashes-per-second photosensitivity limit; do not speed this up. */
      "#obPageFlash{position:fixed;inset:0;z-index:99999;pointer-events:none;opacity:0;background:radial-gradient(ellipse at center,rgba(224,87,74,0) 35%,rgba(224,87,74,.28) 72%,rgba(224,87,74,.62) 100%)}",
      "#obPageFlash.on{animation:obPageFlashC 1s ease-in-out 3}",
      "#obPageFlash.warn{background:radial-gradient(ellipse at center,rgba(240,168,40,0) 45%,rgba(240,168,40,.16) 78%,rgba(240,168,40,.34) 100%)}",
      "#obPageFlash.warn.on{animation:obPageFlashW .9s ease-in-out 1}",
      "@keyframes obPageFlashC{0%,100%{opacity:0}50%{opacity:1}}",
      "@keyframes obPageFlashW{0%,100%{opacity:0}50%{opacity:1}}",
      /* Reduced motion: hold a steady glow instead of pulsing. Still unmissable, no strobe. */
      "@media (prefers-reduced-motion:reduce){#obPageFlash.on{animation:none;opacity:.85;transition:opacity .4s}}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  /* ---------- the klaxon: synthesized, no audio file ----------------------------------
     A two-tone alternating blare built from oscillators, so there's no binary in the repo,
     no licence question, and no cache-bust to get wrong. Level picks the pattern: critical
     is the pirate klaxon, warn is a softer double-beep, info never sounds. */
  function audioCtx() {
    if (AC) return AC;
    try {
      var C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      AC = new C();
    } catch (e) { AC = null; }
    return AC;
  }
  function muted() { try { return localStorage.getItem(MUTE_KEY) === "1"; } catch (e) { return false; } }
  function setMuted(v) { try { localStorage.setItem(MUTE_KEY, v ? "1" : "0"); } catch (e) {} }

  /* --KLAXON-SYNTH-START-- (the offline preview harness extracts this block VERBATIM and renders
     it through an OfflineAudioContext, so what Adam auditions is byte-identical to what the page
     plays — keep it self-contained: no closure references beyond its own args.)

     Modelled on an F-16 threat cue rather than a generic klaxon (test-pilot call, 2026-08-09):
     short hard-edged square pulses read as "something has YOU", where a two-tone blare reads as
     "a machine is unhappy". Two primitives compose every pattern:
       obPulseTrain — the RWR-style chirp: fast square bursts, alternating pitch for the warble
       obGrowl      — the AIM-9 seeker buzz: a low sawtooth chopped by an accelerating LFO       */
  function obPulseTrain(ac, t0, s) {
    var t = t0, i, o, g;
    for (i = 0; i < s.count; i++) {
      o = ac.createOscillator(); g = ac.createGain();
      o.type = s.wave || "square";
      o.frequency.setValueAtTime(s.freqs[i % s.freqs.length], t);
      // Hard attack + hard release: the edge is what makes it read as a warning rather than a note.
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(s.peak, t + 0.004);
      g.gain.setValueAtTime(s.peak, t + s.on - 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t + s.on);
      o.connect(g); g.connect(ac.destination);
      o.start(t); o.stop(t + s.on + 0.005);
      t += s.on + s.off;
    }
    return t;
  }
  function obGrowl(ac, t0, s) {
    // osc -> lowpass -> mod (chopped 0..1 by the LFO) -> env (overall shape) -> out.
    // The LFO drives a gain node whose BASE is 0.5 and whose LFO swing is ±0.5, so the carrier is
    // chopped fully to silence and back — that on/off chop is the rasp, not a filter sweep.
    var o = ac.createOscillator(), lfo = ac.createOscillator();
    var lg = ac.createGain(), mod = ac.createGain(), env = ac.createGain(), f = ac.createBiquadFilter();
    o.type = "sawtooth";
    o.frequency.setValueAtTime(s.f0, t0);
    o.frequency.linearRampToValueAtTime(s.f1, t0 + s.dur);
    lfo.type = "square";
    lfo.frequency.setValueAtTime(s.lfo0, t0);
    lfo.frequency.linearRampToValueAtTime(s.lfo1, t0 + s.dur);   // seeker tightening on the target
    lg.gain.setValueAtTime(0.5, t0);
    mod.gain.setValueAtTime(0.5, t0);
    f.type = "lowpass"; f.frequency.setValueAtTime(2600, t0);
    env.gain.setValueAtTime(0.0001, t0);
    env.gain.exponentialRampToValueAtTime(s.peak, t0 + 0.05);
    env.gain.setValueAtTime(s.peak, t0 + s.dur - 0.06);
    env.gain.exponentialRampToValueAtTime(0.0001, t0 + s.dur);
    lfo.connect(lg); lg.connect(mod.gain);
    o.connect(f); f.connect(mod); mod.connect(env); env.connect(ac.destination);
    o.start(t0); lfo.start(t0);
    o.stop(t0 + s.dur + 0.02); lfo.stop(t0 + s.dur + 0.02);
    return t0 + s.dur;
  }
  function obPlaySpec(ac, t0, spec) {
    var t = t0;
    for (var i = 0; i < spec.length; i++) {
      var seg = spec[i];
      if (seg.gap) { t += seg.gap; continue; }
      t = (seg.kind === "growl") ? obGrowl(ac, t, seg) : obPulseTrain(ac, t, seg);
    }
    return t;
  }
  // Peak is deliberately high for the threat tones — this has to cut through game audio on a
  // second screen, and a square wave at 0.16 disappears under a running Elite. Verified
  // clip-free (no sample exceeds 1.0) by the offline render; pulses never overlap, and the
  // growl's carrier is chopped by a 0..1 modulator so it can't exceed its own env peak.
  var OB_TONES = {
    // A — RWR LAUNCH WARBLE: the "deedle deedle deedle" everyone means by "missile lock".
    warble: [{ freqs: [1046, 1245], count: 20, on: 0.045, off: 0.028, peak: 0.60 }],
    // B — LOCK TONE: one pitch, hammered. Colder, more "acquired" than "incoming".
    lock: [{ freqs: [1000], count: 12, on: 0.070, off: 0.055, peak: 0.60 }],
    // C — SEEKER GROWL -> LOCK: the AIM-9 buzz tightening, then breaking into the warble.
    growl: [
      { kind: "growl", f0: 150, f1: 240, lfo0: 18, lfo1: 52, dur: 0.85, peak: 0.55 },
      { gap: 0.05 },
      { freqs: [1046, 1245], count: 10, on: 0.045, off: 0.028, peak: 0.62 }
    ],
    // Fuel-low and friends: same family, lower and slower so it never reads as a threat.
    soft: [{ freqs: [660], count: 2, on: 0.10, off: 0.09, peak: 0.30 }]
  };
  /* --KLAXON-SYNTH-END-- */

  // Which threat tone this device plays. Per-device like the mute and the theme dials — the
  // point is that Adam and a test pilot can A/B them in flight without a redeploy, so it must
  // NOT be server-synced. An unknown stored value falls back to the default rather than going
  // silent. NOTE: this picks the BOARD's tone only; the rig's own klaxon is chosen in EDMC
  // settings (blades_alarm_tone) and defaults to the same warble.
  var TONE_ORDER = ["warble", "lock", "growl"];
  var TONE_LABEL = { warble: "WARBLE", lock: "LOCK", growl: "GROWL" };
  function tone() {
    var t; try { t = localStorage.getItem(TONE_KEY); } catch (e) {}
    return (t && OB_TONES[t] && TONE_ORDER.indexOf(t) >= 0) ? t : TONE_ORDER[0];
  }
  function setTone(t) { try { localStorage.setItem(TONE_KEY, t); } catch (e) {} }
  function nextTone() { return TONE_ORDER[(TONE_ORDER.indexOf(tone()) + 1) % TONE_ORDER.length]; }

  function klaxon(level, force) {
    if (!force && muted()) return;
    var pat = (level === "critical") ? OB_TONES[tone()] : (level === "warn" ? OB_TONES.soft : null);
    if (!pat) return;
    var ac = audioCtx(); if (!ac) return;
    // Browsers hold audio until a user gesture. If we're still suspended, say so in the strip
    // rather than failing silently — a muted alarm you think is armed is worse than none.
    if (ac.state === "suspended") {
      try { ac.resume(); } catch (e) {}
      if (ac.state === "suspended") { audioBlocked = true; markBlocked(); return; }
    }
    audioBlocked = false; markBlocked();
    obPlaySpec(ac, ac.currentTime + 0.03, pat);
  }
  function markBlocked() {
    var s = document.getElementById("obAlertStrip");
    if (s) s.classList.toggle("blocked", !!audioBlocked && !muted());
  }
  // Arm audio on the first real gesture anywhere on the page, so a klaxon that fires while
  // Adam is mid-click isn't the one that gets swallowed.
  function armAudioOnce() {
    var fn = function () {
      var ac = audioCtx();
      if (ac && ac.state === "suspended") { try { ac.resume().then(function () { audioBlocked = false; markBlocked(); }); } catch (e) {} }
      else if (ac) { audioBlocked = false; markBlocked(); }
      document.removeEventListener("pointerdown", fn, true);
      document.removeEventListener("keydown", fn, true);
    };
    document.addEventListener("pointerdown", fn, true);
    document.addEventListener("keydown", fn, true);
  }

  var TILES = [
    { k: "sys",   lbl: "System" },
    { k: "ship",  lbl: "Ship" },
    { k: "fuel",  lbl: "Fuel" },
    { k: "cargo", lbl: "Cargo" },
    { k: "status",lbl: "State" }
  ];

  function mount() {
    if (document.getElementById("obTelStrip")) return document.getElementById("obTelStrip");
    injectCss();
    var strip = document.createElement("div"); strip.id = "obTelStrip"; strip.className = "stale";
    strip.innerHTML =
      '<div class="ot-head">◈ LIVE TELEMETRY' +
        '<span class="ot-live"><span class="ot-dot"></span><span class="ot-ago">connecting…</span></span></div>' +
      '<div class="ot-grid">' +
        TILES.map(function (t) {
          return '<div class="ot-tile" data-t="' + t.k + '"><div class="ot-lbl">' + t.lbl + '</div>' +
                 '<div class="ot-val">—</div><div class="ot-sub"></div></div>';
        }).join("") +
      '</div>';
    // ── MOUNT ORDER (changed 2026-08-12, Adam's call) ──────────────────────────────────
    // Telemetry + the alert strip now sit ABOVE the site selector, so the selector reads as
    // the start of the build content rather than as a header the live state hangs off. The
    // alert strip mounts directly under this one, so the resulting order on both boards is
    // telemetry → alerts → ◈ SITE → the build view.
    // ⚠ .buildbar is tried FIRST and inserted BEFORE it. Previously .dossier won and this
    // landed after the bar; flipping the preference is what moves it on both pages at once.
    var bar = document.querySelector(".buildbar");
    if (bar && bar.parentNode) { bar.parentNode.insertBefore(strip, bar); return strip; }
    var anchor = document.querySelector(".dossier") || document.querySelector(".controls");
    if (anchor && anchor.parentNode) { anchor.parentNode.insertBefore(strip, anchor); return strip; }
    var wrap = document.querySelector(".wrap") || document.body; wrap.appendChild(strip); return strip;
  }

  // ── IS THIS BROWSER ON THE COCKPIT PC? (b3.23) ───────────────────────────────────────
  // Adam's point, and it is right: on a phone or a second machine the ↵ GAME button is
  // furniture. There is no browser API for "am I on the same box as that process", so this
  // INFERS it from the one observable that only exists when the answer is yes:
  //
  //   press ↵ GAME → the plugin refocuses Elite → THIS browser loses focus.
  //
  // ★ The plugin's own outcome is what makes the inference sound. "Focus did not move here"
  // is ambiguous between "wrong machine" and "Windows refused the foreground", and those want
  // opposite responses — hide the button vs. definitely keep it. So we only count evidence
  // when the plugin says it SUCCEEDED. A failed refocus teaches us nothing and is discarded.
  //
  // ⚠ Asymmetric on purpose. A blur is conclusive: focus moved here, so this IS the cockpit —
  // recorded once and never revisited. "Remote" is a guess, so it needs TWO clean presses
  // before it hides anything, and hiding is always recoverable with ?rfbutton=1. Wrongly
  // keeping a useless button costs a few pixels; wrongly hiding a working one costs trust.
  //
  // ⚠ rfAt is the RIG's clock. It is never compared against the browser's — we only watch for
  // the value CHANGING after a press. Comparing two clocks is a bug this project already
  // shipped once, in the refocus freshness gate.
  var DEV_KEY = "ob_rf_dev", DEV_MISS_KEY = "ob_rf_miss", DEV_WINDOW_MS = 12000;
  var pressWatch = null;

  function devVerdict() { try { return localStorage.getItem(DEV_KEY) || ""; } catch (e) { return ""; } }
  function setVerdict(v) { try { localStorage.setItem(DEV_KEY, v); } catch (e) {} }
  function misses() { try { return parseInt(localStorage.getItem(DEV_MISS_KEY) || "0", 10) || 0; } catch (e) { return 0; } }
  function setMisses(n) { try { localStorage.setItem(DEV_MISS_KEY, String(n)); } catch (e) {} }
  // ?rfbutton=1 RESETS the verdict, it does not merely reveal the button. A device that has
  // been judged wrongly must be able to re-learn; showing the control while leaving "cockpit"
  // on disk would leave judgeDevice permanently refusing to reconsider.
  // ⚠ MEMOISED, and it has to be. showBackBtn() calls this from paintBack(), which runs on
  // every poll AND every second from the age timer — so an un-memoised reset would wipe the
  // miss counter continuously and the device could never accumulate the two presses it needs
  // to re-learn. The clear must happen exactly once per page load.
  var _forced = null;
  function forceShow() {
    if (_forced !== null) return _forced;
    try {
      _forced = /[?&]rfbutton=1/.test(location.search);
      if (_forced) { localStorage.removeItem(DEV_KEY); localStorage.removeItem(DEV_MISS_KEY); }
    } catch (e) { _forced = false; }
    return _forced;
  }
  function showBackBtn() { return forceShow() || devVerdict() !== "remote"; }

  // Called on every poll. Resolves a press that is still waiting for its answer.
  // ★ A BLUR ALONE PROVES NOTHING — corrected 2026-08-13, after a Mac marked itself the
  // cockpit. The old order checked `blurred` FIRST and treated it as conclusive. But a browser
  // blurs for a dozen unrelated reasons — an app switch, a notification, clicking another
  // window — and this watches for 12 seconds, which is a wide net for coincidence.
  //
  // The rung is what disambiguates, and b3.25 is what made it possible to ask:
  //   • "already"  -> Elite was ALREADY foreground, so the plugin MOVED NOTHING. A blur here
  //                   cannot have been caused by a refocus that never happened. This is in
  //                   fact the signature of a REMOTE device: you pressed, and the rig's
  //                   foreground was already where it should be.
  //   • direct / alt-tap / attach / alt-tab -> the foreground genuinely MOVED to Elite. Only
  //                   then does a blur here mean "it moved away from me", i.e. this is the rig.
  //   • "failed"   -> inconclusive, discarded, as before.
  //
  // So blur is now necessary but not sufficient, and it is only ever read alongside a rung
  // that represents actual movement.
  var RF_MOVED_RUNGS = { direct: 1, "alt-tap": 1, attach: 1, "alt-tab": 1 };

  function judgeDevice() {
    if (!pressWatch) return;
    var t = (TEL && TEL.telemetry) || {};
    var moved = t.rfAt && t.rfAt !== pressWatch.rfAtBefore;
    if (moved) {
      var rung = String(t.rfRung || "");
      if (RF_MOVED_RUNGS[rung] && pressWatch.blurred) {
        // The foreground really moved to Elite, and THIS browser is what it moved away from.
        setVerdict("cockpit"); setMisses(0);
      } else if (rung && rung !== "failed") {
        // Either Elite was already there ("already"), or it moved and we did not lose focus.
        // Both say: the foreground this plugin controls is not on this screen.
        var n = misses() + 1; setMisses(n);
        if (n >= 2 && devVerdict() !== "cockpit") setVerdict("remote");
      }
      // "failed" teaches nothing — it cannot separate wrong-machine from Windows-refused.
      pressWatch.done(); pressWatch = null; paintBack(); return;
    }
    if (Date.now() - pressWatch.at > DEV_WINDOW_MS) { pressWatch.done(); pressWatch = null; }
  }

  function watchPress() {
    if (pressWatch) pressWatch.done();
    var w = { at: Date.now(), blurred: false,
              rfAtBefore: ((TEL && TEL.telemetry && TEL.telemetry.rfAt) || 0) };
    function onBlur() { w.blurred = true; }
    function onVis() { if (document.hidden) w.blurred = true; }
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVis);
    w.done = function () {
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVis);
    };
    pressWatch = w;
  }

  // ── BACK TO GAME (b3.22) ──────────────────────────────────────────────────────────────
  // Explicit intent: the pilot says "I'm done here, put me back". Everything else that moves
  // focus is the plugin INFERRING it from a NAV send or a toggle; this is the one that isn't
  // a guess, which is why the plugin lets it skip the refocusact opt-in and the cooldown.
  //
  // ★ IT REPORTS WHAT IT ACTUALLY KNOWS, WHICH IS LESS THAN "IT WORKED". The board cannot
  // observe the Windows foreground — it only knows the request was accepted. So the label
  // says SENT, not DONE, and the plugin's own status line is where the outcome lives. A
  // button claiming success it cannot see is how you end up trusting a dead feature.
  // Body-mounted so it survives every re-render of the board and stays put while you scroll.
  function mountBack() {
    var el = document.getElementById("obBackFix");
    if (el) return el;
    injectCss();
    el = document.createElement("span");
    el.id = "obBackFix"; el.setAttribute("data-a", "back");
    el.setAttribute("role", "button"); el.setAttribute("tabindex", "0");
    el.textContent = "↵ GAME";
    el.style.display = "none";        // paintBack decides; never flash before we know
    document.body.appendChild(el);
    return el;
  }

  function wireBack() {
    var btn = document.getElementById("obBackFix");
    if (!btn || btn.__obWired) return;
    btn.__obWired = true;
    function go() {
      if (btn.hasAttribute("disabled")) return;
      var was = btn.textContent;
      watchPress();                      // b3.23 — begin listening before the request goes out
      btn.textContent = "…";
      fetch("/blades/api/act", {
        method: "POST", credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "button" })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (j) {
          var ok = !!(j && j.ok);
          btn.textContent = ok ? "↵ SENT" : "↵ FAILED";
          btn.classList.toggle("sent", ok);
          btn.setAttribute("title", ok
            ? "Sent — your plugin picks this up on its next poll (~5s) and hands focus to Elite"
            : "Could not reach the board API — nothing was sent");
          setTimeout(function () { btn.textContent = was; btn.classList.remove("sent"); paintBack(); }, 4000);
        })
        .catch(function () {
          btn.textContent = "↵ FAILED";
          setTimeout(function () { btn.textContent = was; paintBack(); }, 4000);
        });
    }
    btn.addEventListener("click", go);
    btn.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); }
    });
  }

  // Disabled while the plugin isn't reporting: with nothing polling, the press would write a
  // KV record nobody reads and the button would look broken for a reason the pilot can't see.
  // The title says WHY, rather than leaving a greyed control unexplained.
  function paintBack() {
    var btn = document.getElementById("obBackFix");
    if (!btn) return;
    if (!showBackBtn()) { btn.style.display = "none"; return; }
    btn.style.display = "inline-block";
    var live = !!(TEL && TEL.telemetry && TEL.ageMs != null && TEL.ageMs < STALE_MS);
    if (live) {
      btn.removeAttribute("disabled");
      btn.setAttribute("title", "Hand focus back to Elite (lands within ~5s, on the plugin's next poll)");
    } else {
      btn.setAttribute("disabled", "disabled");
      btn.setAttribute("title", "Your plugin isn't reporting, so there is nothing to hand focus back to");
    }
  }

  function setTile(strip, k, val, sub, cls) {
    var tile = strip.querySelector('.ot-tile[data-t="' + k + '"]'); if (!tile) return;
    tile.classList.remove("warn", "crit");
    if (cls) tile.classList.add(cls);
    tile.querySelector(".ot-val").innerHTML = val;
    tile.querySelector(".ot-sub").textContent = sub || "";
  }

  function paint(strip) {
    var live = !!(TEL && TEL.telemetry && TEL.ageMs != null && TEL.ageMs < STALE_MS);
    strip.classList.toggle("stale", !live);
    mountBack(); wireBack(); judgeDevice(); paintBack();
    var ago = strip.querySelector(".ot-ago");
    if (!TEL || TEL.ageMs == null) { if (ago) ago.textContent = "offline — plugin not reporting"; }
    else if (live) { if (ago) ago.textContent = "LIVE · " + agoStr(TEL.ageMs); }
    else { if (ago) ago.textContent = "stale · last seen " + agoStr(TEL.ageMs); }

    var t = (TEL && TEL.telemetry) || {};
    // ── FAIL TO GREY, NOT TO BLANK (changed 2026-08-12, Adam's call) ────────────────────
    // This used to wipe every tile to "—" the moment the feed went quiet, on the principle
    // of never showing a stale position as if it were current. The principle is right; the
    // implementation was heavier than it needed to be. Jumps and loading screens routinely
    // pause the heartbeat for longer than STALE_MS, so the strip blanked several times a
    // run and threw away readings that were perfectly good a moment ago.
    // The honesty requirement is already met WITHOUT blanking: `.stale` greys the whole
    // strip and kills the live dot, and the header reads "stale · last seen 2m ago". A
    // greyed number next to its own age says "this is the last thing we knew" — which is
    // information. A dash says nothing at all.
    // Tiles still start dashed and stay dashed until the FIRST reading arrives: when there
    // is no telemetry at all `t` is {} and every lookup falls through to "—" on its own.
    setTile(strip, "sys", esc(t.sys || "—"), "", null);
    setTile(strip, "ship", esc(shipName(t.ship)), t.shipName ? ('"' + t.shipName + '"') : "", null);
    if (typeof t.fuelPct === "number") {
      // Threshold glow only while LIVE. A stale reading keeps its number but must not keep
      // shouting: a red "critical fuel" tile on a feed that stopped two minutes ago is a
      // claim about right now that we cannot make.
      var fcls = live ? (t.fuelPct <= FUEL_CRIT ? "crit" : (t.fuelPct <= FUEL_LOW ? "warn" : null)) : null;
      setTile(strip, "fuel", t.fuelPct + "<span style='font-size:11px'>%</span>", fcls ? "low — refuel" : "", fcls);
    } else setTile(strip, "fuel", "—", "", null);
    if (typeof t.cargo === "number") {
      var sub = (typeof t.cargoCap === "number") ? (fmt(t.cargo) + " / " + fmt(t.cargoCap) + " t") : (fmt(t.cargo) + " t");
      setTile(strip, "cargo", fmt(t.cargo) + "<span style='font-size:11px'> t</span>", sub, null);
    } else setTile(strip, "cargo", "—", "", null);
    setTile(strip, "status", esc(t.status || "—"), "", null);
  }

  /* ---------- brick 3: the alerts strip ---------------------------------------------- */
  function mountAlerts() {
    var ex = document.getElementById("obAlertStrip"); if (ex) return ex;
    injectCss();
    var s = document.createElement("div"); s.id = "obAlertStrip";
    s.innerHTML =
      '<div class="oa-head">◈ ALERTS' +
        '<span class="oa-tools">' +
          '<span class="oa-btn" data-a="tone" role="button" tabindex="0"></span>' +
          '<span class="oa-btn" data-a="mute" role="button" tabindex="0"></span>' +
          '<span class="oa-btn" data-a="test" role="button" tabindex="0" title="Hear the alarm">TEST</span>' +
        "</span></div>" +
      '<div class="oa-blocked">🔇 your browser is holding the sound — click TEST once to arm it</div>' +
      '<ul class="oa-list"></ul>';
    // Sits directly under the telemetry tiles; falls back to the dossier anchor if the
    // tile strip never mounted.
    var tel = document.getElementById("obTelStrip");
    if (tel && tel.parentNode) tel.parentNode.insertBefore(s, tel.nextSibling);
    else {
      var anchor = document.querySelector(".dossier");
      if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(s, anchor);
      else (document.querySelector(".wrap") || document.body).appendChild(s);
    }
    var mute = s.querySelector('[data-a="mute"]'), test = s.querySelector('[data-a="test"]');
    var toneBtn = s.querySelector('[data-a="tone"]');
    function paintMute() {
      mute.textContent = muted() ? "🔇 MUTED" : "🔊 SOUND";
      mute.classList.toggle("muted", muted());
      mute.setAttribute("title", muted() ? "Alarm sound off on this device" : "Alarm sound on for this device");
      markBlocked();
    }
    function paintTone() {
      toneBtn.textContent = "♪ " + TONE_LABEL[tone()];
      toneBtn.setAttribute("title", "Threat tone on this device — click to try " + TONE_LABEL[nextTone()]
        + " (board only; the rig's own alarm is set in EDMC)");
    }
    function hit(el, fn) {
      el.addEventListener("click", fn);
      el.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); fn(); } });
    }
    hit(mute, function () { setMuted(!muted()); paintMute(); });
    // Cycling the tone PLAYS it — the whole point is auditioning, and clicking through three
    // labels in silence tells you nothing. Forced, so it works while muted too.
    hit(toneBtn, function () { setTone(nextTone()); paintTone(); klaxon("critical", true); });
    // TEST always sounds, mute or not — it's how you check the alarm still works, and it's
    // the user gesture that unblocks WebAudio.
    hit(test, function () { klaxon("critical", true); });
    paintMute(); paintTone();
    return s;
  }

  function freshAlerts(list) {
    // An alert with no timestamp is kept rather than dropped: unknown age must not mean
    // "expired", or a worker that stops sending ts would silently empty the card.
    var cut = Date.now() - ALERT_TTL_MS;
    return (list || []).filter(function (a) { return !a || !a.ts ? true : a.ts >= cut; });
  }

  function renderAlerts(list) {
    LAST_ALERTS = list || [];
    list = freshAlerts(list);
    var s = mountAlerts();
    var ul = s.querySelector(".oa-list");
    if (!list || !list.length) {
      ul.innerHTML = '<li class="oa-quiet">All quiet — no alerts from your ship.</li>';
      return;
    }
    ul.innerHTML = list.slice(0, ALERTS_SHOW).map(function (a) {
      var lvl = (a.level === "critical" || a.level === "warn") ? a.level : "info";
      var when = a.ts ? agoStr(Math.max(0, Date.now() - a.ts)) : "";
      return '<li class="oa-item ' + lvl + '"><span class="oa-led"></span>' +
        '<span class="oa-msg">' + esc(a.msg) + "</span>" +
        '<span class="oa-when">' + esc(when) + "</span></li>";
    }).join("");
  }

  /* The page-flash overlay is created lazily and reused. Kept OUTSIDE the strip so it is
     unaffected by the strip's own layout, scroll position, or a collapsed dashboard. */
  var pageFlashEl = null, pageFlashTimer = null;
  function pageFlash(level) {
    try {
      if (!pageFlashEl || !pageFlashEl.isConnected) {
        pageFlashEl = document.createElement("div");
        pageFlashEl.id = "obPageFlash";
        document.body.appendChild(pageFlashEl);
      }
      var warn = (level !== "critical");
      pageFlashEl.className = warn ? "warn" : "";
      void pageFlashEl.offsetWidth;              // restart the animation on a repeat alert
      pageFlashEl.classList.add("on");
      if (pageFlashTimer) clearTimeout(pageFlashTimer);
      // Slightly longer than the animation so the class is cleared after it finishes,
      // never mid-pulse (which would leave the overlay stuck visible).
      pageFlashTimer = setTimeout(function () {
        if (pageFlashEl) pageFlashEl.classList.remove("on");
      }, warn ? 1200 : 3400);
    } catch (e) {}
  }

  function flash(level) {
    pageFlash(level);
    var s = document.getElementById("obAlertStrip"); if (!s) return;
    var cls = level === "critical" ? "flash-critical" : "flash-warn";
    s.classList.remove("flash-critical", "flash-warn");
    void s.offsetWidth;                      // restart the animation on a repeat alert
    s.classList.add(cls);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { s.classList.remove("flash-critical", "flash-warn"); }, FLASH_MS);
  }

  // Decide what's NEW and therefore what gets to make noise. The first list we ever see is
  // the backlog — marked seen silently, so opening the page after a rough trip doesn't set
  // the klaxon off for scans that happened an hour ago.
  function handleAlerts(list) {
    if (!Array.isArray(list)) return;        // older worker with no alerts field — stay dark
    var first = (SEEN === null);
    if (first) SEEN = {};
    var worst = null;
    for (var i = 0; i < list.length; i++) {
      var a = list[i]; if (!a || !a.id || SEEN[a.id]) continue;
      SEEN[a.id] = 1;
      if (first) continue;
      if (a.level === "critical") worst = "critical";
      else if (a.level === "warn" && worst !== "critical") worst = "warn";
    }
    renderAlerts(list);
    if (worst) { flash(worst); klaxon(worst); }
  }

  function api() {
    return fetch("/blades/api/telemetry", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  var busy = false;
  function tick(strip) {
    if (document.hidden || busy) return; busy = true;
    api().then(function (d) {
      busy = false;
      if (d && d.ok) { TEL = d; markLocal(TEL); lastTs = d.ts || 0; handleAlerts(d.alerts); }
      paint(strip);
    });
  }

  var bootTries = 0;
  function boot() {
    api().then(function (d) {
      // A null response is a TRANSIENT failure (network blip / non-ok at page load), not a
      // verdict — retry a few times with backoff instead of giving up, otherwise one blip at
      // load leaves the pilot with no strip until a manual reload. A definitive "not eligible"
      // answer (not signed in / no CMDR bound) is NOT transient, so we stop quietly there.
      if (d == null) { if (bootTries++ < 5) setTimeout(boot, 2000 + bootTries * 1000); return; }
      if (!d.ok || d.needsSetup) return;   // not signed in / no CMDR bound — stay hidden
      TEL = d;
      markLocal(TEL);
      var strip = mount();
      paint(strip);
      armAudioOnce();
      handleAlerts(d.alerts);          // backlog: rendered, marked seen, silent
      setInterval(function () { tick(strip); }, POLL_MS);
      // keep the "Ns ago" label ticking between polls so it feels live — measured from the local
      // reference captured at each poll (skew-proof), not the server epoch vs the browser clock.
      tsAgeTimer = setInterval(function () {
        if (TEL && TEL._ageAt != null) { TEL.ageMs = liveAge(TEL); paint(strip); }
        // Re-render only when something has actually aged out, so an idle card is not
        // rebuilt every second for nothing.
        if (LAST_ALERTS.length && freshAlerts(LAST_ALERTS).length !== LAST_ALERTS.length) {
          renderAlerts(LAST_ALERTS);
        }
      }, 1000);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(strip); });
    });
  }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
