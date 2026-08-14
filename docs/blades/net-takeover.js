/* Blades SQUAD NET takeover — member ticker blare, driven by /blades/api/plugin-status.
   Included on member ticker pages only (colonization, commander, onboarding, flight). The
   public home ticker (GalNet + Community Goals) never loads this, so it never blares.

   Readability: only the LEFT TAG, the BORDER, and the KEYWORD ("RESTART EDMC" /
   "COMPLETE SETUP") flash amber<->fleet. The rest of the message sits on the normal ticker
   background so it stays readable.

   - needsRestart -> tag/border/keyword flash; blares until the plugin reports the target
     version (clears itself on the next poll after an EDMC restart).
   - needsSetup (pre-2.0 / no heartbeat) -> blares "COMPLETE SETUP", surfaces a SETUP GUIDE
     button, and the blare links to the setup guide.
   - Also gates any test-pilot chip on the page to the real test-pilot role. (The commander
     page's own #testPilotBtn was removed 2026-08-13 as a duplicate of the toggle testpilot.js
     injects by the colour dial; the selector below is kept for [data-testpilot] chips.) */
(function () {
  var POLL_MS = 15000, OV_ID = "obNetUrgent", STYLE_ID = "obNetStyle";

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style"); st.id = STYLE_ID;
    st.textContent = [
      "@keyframes obNetBorder{0%,49%{border-color:#ff7a12}50%,100%{border-color:#13a9ff}}",
      "@keyframes obNetTag{0%,49%{background:#ff7a12;color:#0a0705}50%,100%{background:#13a9ff;color:#04121a}}",
      "@keyframes obNetKey{0%,49%{color:#ff7a12}50%,100%{color:#13a9ff}}",
      "@keyframes obNetRun{from{transform:translateX(0)}to{transform:translateX(-50%)}}",
      ".ticker.ob-urgent{animation:obNetBorder .7s steps(1,end) infinite}",
      ".ticker.ob-urgent .tag{animation:obNetTag .7s steps(1,end) infinite}",
      "#" + OV_ID + "{position:absolute;inset:0;z-index:1;display:flex;align-items:center;overflow:hidden;text-decoration:none;background:color-mix(in srgb,var(--accent) 7%,var(--bg))}",
      "#" + OV_ID + ".ob-link{cursor:pointer}",
      "#" + OV_ID + " .obrun{white-space:nowrap;animation:obNetRun 18s linear infinite}",
      "#" + OV_ID + " .obseg{font-family:var(--font-head,inherit);font-weight:700;font-size:12.5px;letter-spacing:1px;color:var(--text);padding-left:12px}",
      "#" + OV_ID + " .obkey{font-weight:800;animation:obNetKey .7s steps(1,end) infinite}",
      "@media(prefers-reduced-motion:reduce){.ticker.ob-urgent{animation:none;border-color:#ff7a12}.ticker.ob-urgent .tag{animation:none;background:#ff7a12;color:#0a0705}#" + OV_ID + " .obrun{animation:none}#" + OV_ID + " .obkey{animation:none;color:#ff7a12}}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  function tickerEl() { return document.querySelector(".ticker"); }

  function setTag(txt) {
    var tk = tickerEl(); if (!tk) return;
    var tag = tk.querySelector(".tag"); if (!tag) return;
    if (txt === null) {
      if (tag.dataset.obOrig != null) { tag.textContent = tag.dataset.obOrig; delete tag.dataset.obOrig; }
    } else {
      if (tag.dataset.obOrig == null) tag.dataset.obOrig = tag.textContent;
      tag.textContent = txt;
    }
  }

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>]/g, function (c) { return ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]; }); }

  // key = the flashing keyword; rest = the readable remainder of the message.
  function showBlare(tag, key, rest, href) {
    injectCss();
    var tk = tickerEl(); if (!tk) return;
    if (getComputedStyle(tk).position === "static") tk.style.position = "relative";
    tk.classList.add("ob-urgent"); setTag(tag);
    var ov = document.getElementById(OV_ID);
    var wantAnchor = !!href;
    if (ov && ((ov.tagName === "A") !== wantAnchor)) { ov.remove(); ov = null; }
    if (!ov) { ov = document.createElement(wantAnchor ? "a" : "div"); ov.id = OV_ID; tk.appendChild(ov); }
    if (wantAnchor) { ov.setAttribute("href", href); ov.className = "ob-link"; } else { ov.removeAttribute("href"); ov.className = ""; }
    var seg = '<span class="obseg">⚠ <span class="obkey">' + esc(key) + '</span> ' + esc(rest) + '     ◆     </span>';
    ov.innerHTML = '<span class="obrun">' + seg + seg + seg + seg + '</span>';
  }

  function clearBlare() {
    var tk = tickerEl(); if (tk) tk.classList.remove("ob-urgent");
    setTag(null);
    var ov = document.getElementById(OV_ID); if (ov) ov.remove();
  }

  function surfaceSetupGuide(on) {
    var links = document.querySelectorAll('a[href="/blades/onboarding/"],a[href="/blades/onboarding"]');
    if (on) {
      var any = false;
      links.forEach(function (a) { any = true; if (getComputedStyle(a).display === "none") { a.setAttribute("data-ob-revealed", "1"); a.style.display = ""; } });
      if (!any) {
        var nav = document.querySelector(".blades-nav");
        if (nav && !document.getElementById("obSetupGuide")) {
          var a = document.createElement("a");
          a.id = "obSetupGuide"; a.className = "bn"; a.href = "/blades/onboarding/"; a.textContent = "⚑ SETUP GUIDE";
          nav.appendChild(a);
        }
      }
    } else {
      document.querySelectorAll('a[data-ob-revealed="1"]').forEach(function (a) { a.style.display = "none"; a.removeAttribute("data-ob-revealed"); });
      var inj = document.getElementById("obSetupGuide"); if (inj) inj.remove();
    }
  }

  var active = null;
  function apply(d) {
    document.querySelectorAll('#testPilotBtn,[data-testpilot]').forEach(function (b) { b.style.display = (d && d.testPilot) ? "" : "none"; });
    if (d && d.needsRestart) {
      active = "restart";
      showBlare("◄ RESTART EDMC", "RESTART EDMC", "— updating to v" + ((d.latest && d.latest.version) || "?") + " · relaunch EDMC to finish the update", null);
      surfaceSetupGuide(false);
    } else if (d && d.needsSetup) {
      active = "setup";
      showBlare("◄ COMPLETE SETUP", "COMPLETE SETUP", "— run the Blades Registrar plugin (v2+) so your commander syncs · tap for the Setup Guide", "/blades/onboarding/");
      surfaceSetupGuide(true);
    } else if (active) {
      active = null; clearBlare(); surfaceSetupGuide(false);
    }
  }

  function poll() {
    fetch("/blades/api/plugin-status", { credentials: "same-origin" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(apply).catch(function () {});
  }
  function boot() { injectCss(); poll(); setInterval(poll, POLL_MS); }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
