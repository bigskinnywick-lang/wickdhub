/* Blades SQUAD NET takeover — member ticker blare, driven by /blades/api/plugin-status.
   Included on member ticker pages only (colonization, commander, onboarding). The public
   home ticker (GalNet + Community Goals) never loads this, so it never blares.

   - needsRestart -> whole bar flashes amber<->fleet, tag "RESTART EDMC", blares until the
     plugin reports the target version (clears itself on the next poll after an EDMC restart).
   - needsSetup (pre-2.0 / no heartbeat) -> blares "COMPLETE SETUP" and surfaces a SETUP GUIDE
     button; the blare is a link to the setup guide.
   - Also gates any #testPilotBtn on the page to the real test-pilot role. */
(function () {
  var POLL_MS = 15000, OV_ID = "obNetUrgent", STYLE_ID = "obNetStyle";

  function injectCss() {
    if (document.getElementById(STYLE_ID)) return;
    var st = document.createElement("style"); st.id = STYLE_ID;
    st.textContent = [
      "@keyframes obNetEmg{0%,49%{background:color-mix(in srgb,#ff7a12 34%,#0a0705)}50%,100%{background:color-mix(in srgb,#13a9ff 36%,#0a0705)}}",
      "@keyframes obNetTag{0%,49%{background:#ff7a12;color:#0a0705}50%,100%{background:#13a9ff;color:#04121a}}",
      "@keyframes obNetRun{from{transform:translateX(0)}to{transform:translateX(-50%)}}",
      ".ticker.ob-urgent{border-color:#ff7a12!important}",
      ".ticker.ob-urgent .tag{animation:obNetTag .7s steps(1,end) infinite}",
      "#" + OV_ID + "{position:absolute;inset:0;z-index:1;display:flex;align-items:center;overflow:hidden;text-decoration:none;animation:obNetEmg .7s steps(1,end) infinite}",
      "#" + OV_ID + ".ob-link{cursor:pointer}",
      "#" + OV_ID + " .obrun{white-space:nowrap;font-family:var(--font-head,inherit);font-weight:700;font-size:12.5px;letter-spacing:1px;color:#0a0705;text-shadow:0 1px 0 rgba(255,255,255,.25);animation:obNetRun 18s linear infinite;padding-left:12px}",
      "@media(prefers-reduced-motion:reduce){#" + OV_ID + "{animation:none;background:color-mix(in srgb,#ff7a12 30%,#0a0705)}.ticker.ob-urgent .tag{animation:none;background:#ff7a12;color:#0a0705}#" + OV_ID + " .obrun{animation:none}}"
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

  function showBlare(tag, msg, href) {
    injectCss();
    var tk = tickerEl(); if (!tk) return;
    if (getComputedStyle(tk).position === "static") tk.style.position = "relative";
    tk.classList.add("ob-urgent"); setTag(tag);
    var ov = document.getElementById(OV_ID);
    var wantAnchor = !!href;
    if (ov && ((ov.tagName === "A") !== wantAnchor)) { ov.remove(); ov = null; }
    if (!ov) { ov = document.createElement(wantAnchor ? "a" : "div"); ov.id = OV_ID; tk.appendChild(ov); }
    if (wantAnchor) { ov.setAttribute("href", href); ov.className = "ob-link"; } else { ov.removeAttribute("href"); ov.className = ""; }
    var run = "⚠ " + msg + "    ◆    ";
    ov.innerHTML = '<span class="obrun">' + run + run + run + run + '</span>';
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
      showBlare("◄ RESTART EDMC", "RESTART EDMC — updating to v" + ((d.latest && d.latest.version) || "?") + " · relaunch EDMC to finish the update", null);
      surfaceSetupGuide(false);
    } else if (d && d.needsSetup) {
      active = "setup";
      showBlare("◄ COMPLETE SETUP", "COMPLETE SETUP — run the Blades Registrar plugin (v2+) so your commander syncs · tap for the Setup Guide", "/blades/onboarding/");
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
