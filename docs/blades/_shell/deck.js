/* Onyx Blades — shared deck controls (fullscreen + persistent zoom).
   Members-only. Collapsed to just the fullscreen button; tapping it toggles
   fullscreen AND reveals the zoom cluster, which auto-collapses after idle.
   Zoom (ob_zoom) persists on EVERY page, even while the cluster is hidden. */
(function () {
  /* ---- SHARED SIGN-OUT ---------------------------------------------------
     Cloudflare Access has no post-logout redirect for self-hosted apps.
     Sending the pilot to the TEAM domain's logout URL
     (https://<team>.cloudflareaccess.com/cdn-cgi/access/logout) dumps them on a
     Cloudflare-branded page on a DIFFERENT ORIGIN with no route back — that was
     the bug. Instead hit the logout endpoint on THIS origin (clears the
     CF_Authorization cookie for wickdhub.com), then bounce to the public home
     where they correctly read as logged-out.

     Defined OUTSIDE the members-only gate below so it is always available.
     Mirrors doSignOut() in docs/blades/index.html — if you change one, change both.

     NOTE: this clears the app cookie, not the team-level Access session. Signing
     back in may not re-prompt the IdP. That is the accepted trade for landing
     back on /blades/ instead of a dead Cloudflare page. */
  window.bladesSignOut = function () {
    var go = function () { try { location.replace("/blades/"); } catch (e) { location.href = "/blades/"; } };
    try { fetch("/cdn-cgi/access/logout", { credentials: "include", mode: "no-cors", cache: "no-store" }).then(go, go); }
    catch (e) { go(); }
    setTimeout(go, 1500); // safety net if the fetch stalls
  };

  var Z = 100;
  try { var z = parseInt(localStorage.getItem("ob_zoom") || "100", 10); if (z >= 50 && z <= 250) Z = z; } catch (e) {}

  function applyZoom() {
    try { document.documentElement.style.zoom = (Z / 100); } catch (e) {}
    var l = document.getElementById("obZoomLbl"); if (l) l.textContent = Z + "%";
    try { localStorage.setItem("ob_zoom", String(Z)); } catch (e) {}
  }
  // Apply saved zoom immediately so it stays constant across page loads.
  applyZoom();

  function setZ(v) { Z = Math.max(50, Math.min(250, v)); applyZoom(); }

  var idle = null;
  function collapse() { var g = document.getElementById("deckZoom"); if (g) g.hidden = true; }
  function reveal() {
    var g = document.getElementById("deckZoom"); if (g) g.hidden = false;
    if (idle) clearTimeout(idle);
    idle = setTimeout(collapse, 4000); // shrink back to just the fullscreen button after 4s idle
  }

  function build() {
    if (document.getElementById("deckCtl") || !document.body) return;
    var d = document.createElement("div");
    d.id = "deckCtl"; d.setAttribute("aria-label", "Display controls");
    d.innerHTML =
      '<span id="deckZoom" hidden>' +
        '<button id="obZoomOut" title="Zoom out" aria-label="Zoom out">&#8211;</button>' +
        '<span id="obZoomLbl">100%</span>' +
        '<button id="obZoomIn" title="Zoom in" aria-label="Zoom in">+</button>' +
      '</span>' +
      '<button id="obFull" title="Full screen" aria-label="Toggle full screen">&#9974;</button>';
    document.body.appendChild(d);

    document.getElementById("obZoomOut").onclick = function () { setZ(Z - 10); reveal(); };
    document.getElementById("obZoomIn").onclick  = function () { setZ(Z + 10); reveal(); };
    document.getElementById("obFull").onclick = function () {
      var el = document.documentElement, doc = document;
      var fs = doc.fullscreenElement || doc.webkitFullscreenElement || doc.mozFullScreenElement;
      try {
        if (!fs) { (el.requestFullscreen || el.webkitRequestFullscreen || el.mozRequestFullScreen || function () {}).call(el); }
        else { (doc.exitFullscreen || doc.webkitExitFullscreen || doc.mozCancelFullScreen || function () {}).call(doc); }
      } catch (e) {}
      reveal(); // tapping fullscreen also reveals the zoom cluster
    };

    // 2026-08-13 — adopt the ↵ GAME button if telemetry.js already body-mounted it, so the
    // three floating controls read as one bottom-right group. The button is NOT built here
    // on purpose: deck.js loads on the PUBLIC home page and the setup guide, telemetry.js
    // only on commander + colonization. Building it here would create a members-only control
    // on public pages. Adoption is the half of the handshake that runs when deck wins the
    // race; mountBack() in telemetry.js covers the other order.
    var back = document.getElementById("obBackFix");
    if (back) d.appendChild(back);

    d.style.display = "flex";
    applyZoom();
    collapse(); // start collapsed: just the fullscreen button
  }

  // Members-only: only reveal the control for a signed-in commander.
  function gate() {
    fetch("/blades/api/whoami-cmdr", { headers: { accept: "application/json" }, credentials: "include" })
      .then(function (r) { if (!r.ok) return null; var ct = r.headers.get("content-type") || ""; return ct.indexOf("json") >= 0 ? r.json() : null; })
      .then(function (j) { if (j && j.ok && j.me) build(); })
      .catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", gate); else gate();
})();
