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
      "#obTpTrack{position:fixed;top:8px;right:12px;z-index:99998;font-family:var(--font-head,'Orbitron',sans-serif);font-size:9.5px;letter-spacing:2px;color:var(--good,#57e0a0);border:1px solid var(--good,#57e0a0);border-radius:4px;padding:3px 8px;background:rgba(6,10,7,.72);box-shadow:0 0 9px color-mix(in srgb,var(--good,#57e0a0) 45%,transparent);pointer-events:none}"
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

  function boot() { api("GET").then(function (d) { if (d && d.ok) { STATE = d; if (d.eligible || d.admin) build(); } }); }
  if (document.readyState !== "loading") boot(); else document.addEventListener("DOMContentLoaded", boot);
})();
