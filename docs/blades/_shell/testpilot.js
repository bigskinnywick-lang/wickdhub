/* Blades — test-pilot control group + beta routing (shared, member pages).
   The test-pilot ROLE (admin-granted) makes the group appear; the pilot flicks the
   switch to arm the test track. State is SERVER-SIDE (/blades/api/testpilot), so every
   window on every device shows the same armed/disarmed state at once. No non-test-pilot
   ever sees the group. Increment 1: drives the SITE (beta pages). Wiring the plugin
   channel to this flag is the next deliberate step (the flagged shakedown item). */
(function () {
  var STATE = null;

  function api(method, body) {
    return fetch("/blades/api/testpilot", {
      method: method || "GET", credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
  }

  function armed() { return !!(STATE && STATE.tier && STATE.tier !== "retail"); }

  function injectCss() {
    if (document.getElementById("obTpStyle")) return;
    var st = document.createElement("style"); st.id = "obTpStyle";
    st.textContent = [
      "#obTp{display:inline-flex;align-items:center;gap:9px;flex-wrap:wrap}",
      "#obTp .tpsw{display:inline-flex;align-items:center;gap:8px;cursor:pointer;border:1px solid var(--accent-dim,#a24d08);background:var(--panel2,#1c1109);border-radius:8px;padding:5px 11px;font-family:var(--font-head,'Orbitron',sans-serif);font-size:10.5px;letter-spacing:1.5px;color:var(--muted,#b98a52);user-select:none;touch-action:manipulation;transition:.15s}",
      "#obTp .tpsw:hover{border-color:var(--accent,#ff7a12)}",
      "#obTp .tpled{width:10px;height:10px;border-radius:50%;background:#2a1a0c;border:1px solid #000;transition:.2s}",
      "#obTp.on .tpsw{color:var(--good,#57e0a0);border-color:var(--good,#57e0a0)}",
      "#obTp.on .tpled{background:var(--good,#57e0a0);box-shadow:0 0 9px var(--good,#57e0a0)}",
      "#obTp .tpchk{font-family:var(--font-head,'Orbitron',sans-serif);font-size:10.5px;letter-spacing:1.5px;text-decoration:none;color:var(--muted,#b98a52);border:1px solid var(--line,#3a2410);background:var(--panel,#140d07);padding:6px 12px;border-radius:6px;transition:.15s}",
      "#obTp .tpchk:hover{color:var(--accent-bright,#ffb057);border-color:var(--accent-dim,#a24d08)}",
      "#obTpTrack{position:fixed;top:8px;right:12px;z-index:99998;font-family:var(--font-head,'Orbitron',sans-serif);font-size:9.5px;letter-spacing:2px;color:var(--good,#57e0a0);border:1px solid var(--good,#57e0a0);border-radius:4px;padding:3px 8px;background:rgba(6,10,7,.72);pointer-events:none;transform-origin:right center;animation:obTpBreathe 2.4s ease-in-out infinite}",
      // pronounced breathing pulse (opacity + scale + glow) so a pilot can't miss that the test track is live
      "@keyframes obTpBreathe{0%,100%{opacity:.4;transform:scale(.94);border-color:color-mix(in srgb,var(--good,#57e0a0) 40%,transparent);box-shadow:0 0 3px color-mix(in srgb,var(--good,#57e0a0) 15%,transparent);text-shadow:none}50%{opacity:1;transform:scale(1.06);border-color:var(--good,#57e0a0);box-shadow:0 0 22px color-mix(in srgb,var(--good,#57e0a0) 90%,transparent);text-shadow:0 0 8px color-mix(in srgb,var(--good,#57e0a0) 80%,transparent)}}",
      "@media (prefers-reduced-motion:reduce){#obTpTrack{animation:none;opacity:1;transform:none;box-shadow:0 0 9px color-mix(in srgb,var(--good,#57e0a0) 45%,transparent)}}"
    ].join("\n");
    (document.head || document.documentElement).appendChild(st);
  }

  function cleared() { return !!(STATE && (STATE.eligible || STATE.admin)); }

  function build() {
    if (document.getElementById("obTp") || !cleared()) return;
    injectCss();
    var host = document.querySelector(".controls") || document.querySelector(".blades-nav");
    var g = document.createElement("div"); g.id = "obTp";
    g.innerHTML =
      '<span class="tpsw" role="switch" tabindex="0" aria-label="Test pilot mode">' +
        '<span class="tpled"></span>⚑ TEST PILOT</span>' +
      '<a class="tpchk" href="/blades/checklist/">CHECKLIST</a>';
    if (host && host.classList.contains("controls")) host.appendChild(g);
    else if (host && host.parentNode) host.parentNode.insertBefore(g, host.nextSibling);
    else document.body.appendChild(g);
    var sw = g.querySelector(".tpsw");
    sw.addEventListener("click", toggle);
    sw.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
    render();
  }

  function routeNav() {
    // Increment 1: beta-only nav entry for the Flight Rig (first tenant), shown only when armed.
    var nav = document.querySelector(".blades-nav"); if (!nav) return;
    var fr = document.getElementById("obTpFlight");
    if (armed()) {
      if (!fr) { fr = document.createElement("a"); fr.id = "obTpFlight"; fr.className = "bn"; fr.href = "/blades/beta/flight/"; fr.textContent = "⚑ FLIGHT RIG"; nav.appendChild(fr); }
    } else if (fr) { fr.remove(); }
  }

  function render() {
    var g = document.getElementById("obTp"); if (!g) return;
    g.classList.toggle("on", armed());
    var sw = g.querySelector(".tpsw"); if (sw) sw.setAttribute("aria-checked", armed() ? "true" : "false");
    var mk = document.getElementById("obTpTrack");
    if (armed()) { if (!mk) { mk = document.createElement("div"); mk.id = "obTpTrack"; mk.textContent = "⚑ TEST TRACK"; document.body.appendChild(mk); } }
    else if (mk) { mk.remove(); }
    routeNav();
  }

  function toggle() {
    var next = armed() ? "retail" : "beta";
    api("POST", { tier: next }).then(function (d) { if (d && d.ok) { STATE = d; render(); } });
  }

  // --- live cross-device sync -------------------------------------------------------
  // The tier is server-side, so a flick on ONE device has to reach every other OPEN
  // window on its own — without the pilot reloading. Cloudflare Pages has no push socket,
  // so we poll: a gentle timer, plus an instant re-check whenever the tab regains focus
  // or visibility (so switching back to a window catches up immediately instead of waiting
  // out the interval). We expose _obTierSync() too, so any page that already runs a
  // heartbeat (the colonization board, the plugin-status ticker) can fold this into that
  // existing tick instead of adding a second timer. We re-render ONLY on an actual change,
  // so the poll is cheap and never flickers the control group.
  var POLL_MS = 12000;

  function apply(d) {
    if (!d || !d.ok) return;
    var was = STATE || {};
    var changed = was.tier !== d.tier || was.eligible !== d.eligible || was.admin !== d.admin;
    STATE = d;
    if (!changed) return;
    if (d.eligible || d.admin) { build(); render(); } // build() no-ops if the group is already up
    else {
      // eligibility pulled out from under an open page -> tear the control group down live
      var g = document.getElementById("obTp"); if (g) g.remove();
      var mk = document.getElementById("obTpTrack"); if (mk) mk.remove();
      var fr = document.getElementById("obTpFlight"); if (fr) fr.remove();
    }
  }

  function sync() { return api("GET").then(apply); }
  window._obTierSync = sync; // let an existing page poller drive this instead of our timer

  function boot() {
    api("GET").then(function (d) { if (d && d.ok) { STATE = d; if (d.eligible || d.admin) build(); } });
    setInterval(function () { if (document.visibilityState !== "hidden") sync(); }, POLL_MS);
    document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") sync(); });
    window.addEventListener("focus", sync);
  }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
