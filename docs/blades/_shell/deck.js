/* Onyx Blades — shared deck controls (fullscreen + persistent zoom).
   Members-only. Collapsed to just the fullscreen button; tapping it toggles
   fullscreen AND reveals the zoom cluster, which auto-collapses after idle.
   Zoom (ob_zoom) persists on EVERY page, even while the cluster is hidden. */
(function () {
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
