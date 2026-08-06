/* Blades — MY DASHBOARD live telemetry tile row (shared, MY STATS page).
   Brick 2 of the Commander Dashboard. Renders a strip of live tiles — current system, ship,
   fuel %, cargo, flight state — fed by the Blades Registrar plugin's heartbeat
   (/ingest/navpull -> KV plugin:telemetry -> /blades/api/telemetry). Design rules it honors:
     • LIVENESS + FAIL-TO-GREY: shows "updated Ns ago" when live; if the plugin isn't
       reporting (stale/no data) the tiles go GREY and read "—" rather than showing a stale
       position as if it were current.
     • THRESHOLD GLOW: the fuel tile glows amber when fuel is low.
   Self-contained (own CSS); mounts only for a signed-in, CMDR-bound pilot; polls every ~5s
   while visible, pauses when the tab is hidden. */
(function () {
  var POLL_MS = 5000, STALE_MS = 30000, FUEL_LOW = 25, FUEL_CRIT = 10;
  var TEL = null, tsAgeTimer = null, lastTs = 0;

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

  function injectCss() {
    if (document.getElementById("obTelStyle")) return;
    var st = document.createElement("style"); st.id = "obTelStyle";
    st.textContent = [
      "#obTelStrip{margin:14px 0 4px;border:1px solid var(--accent-dim,#a24d08);background:color-mix(in srgb,var(--accent,#ff7a12) 5%,var(--panel,#140d07));border-radius:var(--radius,12px);overflow:hidden}",
      "#obTelStrip .ot-head{display:flex;align-items:center;gap:10px;padding:9px 14px;border-bottom:1px solid var(--line,#3a2410);font-family:var(--font-head,'Orbitron',sans-serif);font-size:10.5px;letter-spacing:2px;color:var(--accent-bright,#ffb057)}",
      "#obTelStrip .ot-live{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-size:9.5px;letter-spacing:1.5px;color:var(--muted,#b98a52)}",
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
      "@keyframes otPulse{0%,100%{background:var(--panel,#140d07)}50%{background:color-mix(in srgb,var(--warn,#f0a828) 12%,var(--panel,#140d07))}}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
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
    // Insert at the top of the dashboard: before the dossier, else after the build bar.
    var anchor = document.querySelector(".dossier") || null;
    if (anchor && anchor.parentNode) { anchor.parentNode.insertBefore(strip, anchor); return strip; }
    var bar = document.querySelector(".buildbar") || document.querySelector(".controls");
    if (bar && bar.parentNode) { bar.parentNode.insertBefore(strip, bar.nextSibling); return strip; }
    var wrap = document.querySelector(".wrap") || document.body; wrap.appendChild(strip); return strip;
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
    var ago = strip.querySelector(".ot-ago");
    if (!TEL || TEL.ageMs == null) { if (ago) ago.textContent = "offline — plugin not reporting"; }
    else if (live) { if (ago) ago.textContent = "LIVE · " + agoStr(TEL.ageMs); }
    else { if (ago) ago.textContent = "stale · last seen " + agoStr(TEL.ageMs); }

    var t = (TEL && TEL.telemetry) || {};
    if (!live) {   // fail to grey: never show a stale position as if it were current
      TILES.forEach(function (x) { setTile(strip, x.k, "—", "", null); });
      return;
    }
    setTile(strip, "sys", esc(t.sys || "—"), "", null);
    setTile(strip, "ship", esc(shipName(t.ship)), t.shipName ? ('"' + t.shipName + '"') : "", null);
    if (typeof t.fuelPct === "number") {
      var fcls = t.fuelPct <= FUEL_CRIT ? "crit" : (t.fuelPct <= FUEL_LOW ? "warn" : null);
      setTile(strip, "fuel", t.fuelPct + "<span style='font-size:11px'>%</span>", fcls ? "low — refuel" : "", fcls);
    } else setTile(strip, "fuel", "—", "", null);
    if (typeof t.cargo === "number") {
      var sub = (typeof t.cargoCap === "number") ? (fmt(t.cargo) + " / " + fmt(t.cargoCap) + " t") : (fmt(t.cargo) + " t");
      setTile(strip, "cargo", fmt(t.cargo) + "<span style='font-size:11px'> t</span>", sub, null);
    } else setTile(strip, "cargo", "—", "", null);
    setTile(strip, "status", esc(t.status || "—"), "", null);
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
      if (d && d.ok) { TEL = d; lastTs = d.ts || 0; }
      paint(strip);
    });
  }

  function boot() {
    api().then(function (d) {
      if (!d || !d.ok || d.needsSetup) return;   // not signed in / no CMDR bound — stay hidden
      TEL = d;
      var strip = mount();
      paint(strip);
      setInterval(function () { tick(strip); }, POLL_MS);
      // keep the "Ns ago" label ticking between polls so it feels live
      tsAgeTimer = setInterval(function () { if (TEL && TEL.ts) { TEL.ageMs = Date.now() - TEL.ts; paint(strip); } }, 1000);
      document.addEventListener("visibilitychange", function () { if (!document.hidden) tick(strip); });
    });
  }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
