/* Blades — Companion settings panel (shared, MY STATS page).
   A "◈ COMPANION" button in the controls row opens a panel of per-pilot toggles that
   drive the Blades Registrar plugin: Build Registrar (auto-create) + Assist Features
   (honk, more later). State is SERVER-SIDE (/blades/api/plugin-settings) and the plugin
   reads it on its nav poll, so a flip takes effect in-game within ~5s — no EDMC restart.
   Toggle + LED styling mirrors the test-pilot switch. */
(function () {
  var STATE = null;   // { cmdr, settings:{autocreate,honk}, needsSetup }

  var ROWS = [
    { sec: "BUILD REGISTRAR" },
    { k: "autocreate", label: "Auto-create", sub: "create a Raven build when a site has none (safeguarded)" },
    { sec: "ASSIST FEATURES" },
    { k: "honk", label: "Honk on arrival", sub: "auto-fire the Discovery Scanner when you jump · needs a keyboard key on your fire control" },
    { k: "galaxymap", label: "Auto-plot to Galaxy Map", sub: "on a NAV send, open the map + paste the system · needs a keyboard Open-Galaxy-Map bind" },
    { k: "fuel", label: "Fuel safety check", sub: "warn in EDMC when you plot a jump and fuel is already thin — under ~2 jumps' worth, or tank below 20% · not a per-jump stranding check" },
    { k: "pirate", label: "Pirate / cargo-scan alarm", sub: "klaxon here and on your PC the moment something reads your hold · needs no binds" },
    { k: "refocus", label: "Give the stick back", sub: "Windows only · returns focus to Elite via a hotkey (ctrl+alt+e) and automatically when the pirate alarm fires — an unfocused Elite receives NO stick input at all" },
    { k: "refocusact", label: "Back to the game when I act", sub: "Windows only · after a NAV send or an assist toggle, hand focus back to Elite — never while you are just reading the board. Ignores an action older than 20s, so a restart can't yank you out of the game for a click you made ten minutes ago" }
  ];

  function api(method, body) {
    return fetch("/blades/api/plugin-settings", {
      method: method || "GET", credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function on(k) { return !!(STATE && STATE.settings && STATE.settings[k]); }
  // Per-assist readiness the plugin reported (present only for key-pressing assists on a
  // reporting plugin). null = no data -> render exactly as before (older plugin / retail).
  function readyOf(k) { var r = STATE && STATE.readiness && STATE.readiness[k]; return (r && typeof r === "object") ? r : null; }
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  function injectCss() {
    if (document.getElementById("obCompStyle")) return;
    var st = document.createElement("style"); st.id = "obCompStyle";
    st.textContent = [
      "#obCompBtn{cursor:pointer}",
      "#obCompOv{position:fixed;inset:0;z-index:100000;display:none;align-items:flex-start;justify-content:center;background:rgba(4,7,5,.72);backdrop-filter:blur(2px);padding:8vh 16px 16px}",
      "#obCompOv.show{display:flex}",
      "#obCompPan{width:min(440px,94vw);background:var(--panel,#140d07);border:1px solid var(--accent-dim,#a24d08);border-radius:var(--radius,12px);box-shadow:0 18px 60px rgba(0,0,0,.6);font-family:var(--font-body,system-ui,sans-serif);color:var(--fg,#f2d9b8);overflow:hidden}",
      "#obCompPan .oc-head{display:flex;align-items:center;justify-content:space-between;font-family:var(--font-head,'Orbitron',sans-serif);font-size:13px;letter-spacing:2px;color:var(--accent-bright,#ffb057);padding:13px 16px;border-bottom:1px solid var(--line,#3a2410)}",
      "#obCompPan .oc-x{cursor:pointer;color:var(--muted,#b98a52);font-size:15px;line-height:1;padding:2px 4px}",
      "#obCompPan .oc-x:hover{color:var(--accent-bright,#ffb057)}",
      "#obCompPan .oc-note{font-size:11px;color:var(--muted,#b98a52);padding:9px 16px 4px}",
      "#obCompPan .oc-sec{font-family:var(--font-head,'Orbitron',sans-serif);font-size:9.5px;letter-spacing:2px;color:var(--muted,#b98a52);padding:12px 16px 4px;border-top:1px solid var(--line,#3a2410);margin-top:6px}",
      "#obCompPan .oc-sec:first-of-type{border-top:0;margin-top:0}",
      "#obCompPan .oc-row{display:flex;align-items:center;gap:12px;padding:9px 16px}",
      "#obCompPan .oc-lab{flex:1;font-size:13px;color:var(--fg,#f2d9b8)}",
      "#obCompPan .oc-sub{display:block;font-size:11px;color:var(--muted,#b98a52);margin-top:2px}",
      "#obCompPan .oc-sw{display:inline-flex;align-items:center;gap:8px;cursor:pointer;border:1px solid var(--accent-dim,#a24d08);background:var(--panel2,#1c1109);border-radius:8px;padding:6px 11px;font-family:var(--font-head,'Orbitron',sans-serif);font-size:10px;letter-spacing:1.5px;color:var(--muted,#b98a52);user-select:none;touch-action:manipulation;transition:.15s;min-width:70px;justify-content:center}",
      "#obCompPan .oc-sw:hover{border-color:var(--accent,#ff7a12)}",
      "#obCompPan .oc-led{width:10px;height:10px;border-radius:50%;background:#2a1a0c;border:1px solid #000;transition:.2s;flex:none}",
      "#obCompPan .oc-row.on .oc-sw{color:var(--good,#57e0a0);border-color:var(--good,#57e0a0)}",
      "#obCompPan .oc-row.on .oc-led{background:var(--good,#57e0a0);box-shadow:0 0 9px var(--good,#57e0a0)}",
      // not-ready wins over on/off: a red LED + red switch means the assist can't fire until
      // the pilot sets the missing keyboard bind. Rules come AFTER .on so red overrides green.
      "#obCompPan .oc-row.not-ready .oc-sw{color:var(--bad,#e0574a);border-color:var(--bad,#e0574a)}",
      "#obCompPan .oc-row.not-ready .oc-led{background:var(--bad,#e0574a);box-shadow:0 0 9px var(--bad,#e0574a)}",
      "#obCompPan .oc-warn{display:none;font-size:11px;line-height:1.5;color:var(--bad,#e0574a);padding:0 16px 11px}",
      "#obCompPan .oc-row.not-ready + .oc-warn{display:block}",
      "#obCompPan .oc-warn b{color:var(--bad,#e0574a);font-weight:600}",
      "#obCompPan .oc-row.busy .oc-sw{opacity:.5;pointer-events:none}",
      "#obCompPan .oc-soon .oc-lab{opacity:.6}",
      "#obCompPan .oc-soon-tag{font-family:var(--font-head,'Orbitron',sans-serif);font-size:9px;letter-spacing:1.5px;color:var(--muted,#b98a52);border:1px dashed var(--line,#3a2410);border-radius:6px;padding:6px 10px}",
      "#obCompPan .oc-hint{font-size:12px;color:var(--accent-bright,#ffb057);padding:6px 16px 14px}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  function rowHtml(r) {
    if (r.sec) return '<div class="oc-sec">' + r.sec + "</div>";
    var right = r.soon
      ? '<span class="oc-soon-tag">SOON</span>'
      : '<span class="oc-sw" role="switch" tabindex="0" aria-label="' + r.label + '"><span class="oc-led"></span><span class="oc-state">OFF</span></span>';
    var cls = "oc-row" + (r.soon ? " oc-soon" : "");
    var rowEl = '<div class="' + cls + '"' + (r.k ? ' data-k="' + r.k + '"' : "") + ">" +
      '<div class="oc-lab">' + r.label + '<span class="oc-sub">' + r.sub + "</span></div>" + right + "</div>";
    // Adjacent readiness slot (immediate sibling) — CSS reveals it when the row is not-ready.
    if (r.k) rowEl += '<div class="oc-warn" data-warn="' + r.k + '"></div>';
    return rowEl;
  }

  function buildPanel() {
    if (document.getElementById("obCompOv")) return;
    injectCss();
    var ov = document.createElement("div"); ov.id = "obCompOv";
    var body = STATE && STATE.needsSetup
      ? '<div class="oc-hint">Bind your CMDR on this page first, then your Companion settings live here.</div>'
      : ROWS.map(rowHtml).join("");
    ov.innerHTML =
      '<div id="obCompPan" role="dialog" aria-label="Companion settings">' +
        '<div class="oc-head">◈ COMPANION SETTINGS <span class="oc-x" title="Close">✕</span></div>' +
        '<div class="oc-note">Changes apply in-game within ~5s — no EDMC restart.</div>' +
        body +
      "</div>";
    document.body.appendChild(ov);
    ov.addEventListener("click", function (e) { if (e.target === ov || e.target.className === "oc-x") close(); });
    ov.querySelectorAll(".oc-row[data-k] .oc-sw").forEach(function (sw) {
      var row = sw.closest(".oc-row");
      var k = row.getAttribute("data-k");
      sw.addEventListener("click", function () { flip(k); });
      sw.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(k); } });
    });
    render();
  }

  function render() {
    var ov = document.getElementById("obCompOv"); if (!ov) return;
    ROWS.forEach(function (r) {
      if (!r.k) return;
      var row = ov.querySelector('.oc-row[data-k="' + r.k + '"]'); if (!row) return;
      var isOn = on(r.k);
      row.classList.toggle("on", isOn);
      var stx = row.querySelector(".oc-state"); if (stx) stx.textContent = isOn ? "ON" : "OFF";
      var sw = row.querySelector(".oc-sw"); if (sw) sw.setAttribute("aria-checked", isOn ? "true" : "false");
      // Readiness overlay: a key-pressing assist whose binds are missing goes red + locked,
      // with a line naming exactly what to set. No readiness data (older plugin) = no change.
      var rd = readyOf(r.k);
      var notReady = !!(rd && rd.ready === false);
      row.classList.toggle("not-ready", notReady);
      var warn = ov.querySelector('.oc-warn[data-warn="' + r.k + '"]');
      if (warn) {
        if (notReady) {
          var miss = (rd.missing && rd.missing.length) ? rd.missing.join(", ") : "a keyboard bind";
          warn.innerHTML = "⚠ <b>Set " + esc(miss) + "</b> in Elite’s controls — this assist arms itself the moment it’s bound.";
        } else {
          warn.textContent = "";
        }
      }
    });
  }

  function flip(k) {
    var ov = document.getElementById("obCompOv"); if (!ov) return;
    var row = ov.querySelector('.oc-row[data-k="' + k + '"]');
    if (row) row.classList.add("busy");
    var patch = {}; patch[k] = !on(k);
    api("POST", patch).then(function (d) {
      if (row) row.classList.remove("busy");
      if (d && d.ok) { STATE.settings = d.settings; render(); }
    });
  }

  function open() { buildPanel(); var ov = document.getElementById("obCompOv"); if (ov) ov.classList.add("show"); }
  function close() { var ov = document.getElementById("obCompOv"); if (ov) ov.classList.remove("show"); }

  function mountButton() {
    if (document.getElementById("obCompBtn")) return;
    var host = document.querySelector(".controls"); if (!host) return;
    var b = document.createElement("button");
    b.id = "obCompBtn"; b.className = "bb-add"; b.type = "button";
    b.title = "Companion settings — auto-create + assist features (honk, …)";
    b.textContent = "◈ COMPANION";
    b.style.marginLeft = "10px";
    host.appendChild(b);
    b.addEventListener("click", open);
  }

  function boot() {
    api("GET").then(function (d) {
      if (!d || !d.ok) return;      // not signed in / no identity — stay hidden
      STATE = d;
      mountButton();
      document.addEventListener("keydown", function (e) { if (e.key === "Escape") close(); });
    });
  }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
