/* Onyx Blades — RELEASE ANNOUNCEMENT card
 *
 * A prominent, dismissible notice at the top of MY DASHBOARD announcing what just shipped.
 * The squadron is small and nobody reads a changelog, so the release has to come and find
 * the pilot once, then get out of the way permanently.
 *
 * ── HOW "ONCE" WORKS ───────────────────────────────────────────────────────────────────
 * Dismissal is keyed to REL.id, per device, in localStorage — same per-device convention as
 * the theme dial and the alarm mute, and deliberately NOT server-synced: which devices you
 * have read a notice on is not squadron data.
 *
 * ⚠ CHANGE REL.id FOR THE NEXT RELEASE. Reusing an id means every pilot who dismissed the
 * last one never sees the new one — the card would be silently dead for exactly the people
 * who use the board most. The id is the release, not the card.
 *
 * ⚠ AND IT IS NOT A CHANGELOG. It holds ONE release. The durable record is the feature
 * register at /blades/onboarding/features/, which is where the LEARN MORE link goes and
 * where a pilot who dismissed this can still find out what changed. A card that is the only
 * copy of the news is a card that loses the news the moment someone clicks ×.
 *
 * Styles are injected here rather than added to _shell/blades.css: that file is served with
 * NO ?v= cache-buster, so editing it would serve stale CSS from the edge. Same reasoning as
 * ob1.js and adjutant.js.
 *
 * NOT build-managed — standalone _shell asset. Bump ?v= on the script tag when you edit it.
 */
(function () {
  "use strict";

  var REL = {
    id: "2026-08-13-service-record",          // ⚠ bump for the next release, see above
    tag: "NEW",
    title: "Your Service Record is open",
    lede: "The ◈ COMPANION pop-up is retired. What the squadron may show about you and what " +
          "your Adjutant may do for you are now one document you can actually read.",
    items: [
      { h: "◈ Service Record",
        d: "Form OB-1 and your standing orders in one place, in plain language. Reach it from ASSIGNMENTS." },
      { h: "◈ Your Adjutant",
        d: "The Companion, renamed and rethought — the unit assigned to you. Its orders are yours to give." },
      { h: "◈ Assignments card",
        d: "Your unit and every desk you hold, gathered above the site selector instead of scattered across the bar." },
      { h: "◈ Orders that can't lie",
        d: "An assist needing a keyboard bind you haven't set can no longer be switched on — it names the bind instead." }
    ],
    moreHref: "/blades/onboarding/features/",
    moreText: "SEE EVERY FEATURE ▸"
  };

  function key() { return "ob_seen_release"; }

  function seen() {
    try { return localStorage.getItem(key()) === REL.id; } catch (e) { return false; }
  }
  function markSeen() {
    try { localStorage.setItem(key(), REL.id); } catch (e) {}
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function css() {
    if (document.getElementById("ann-style")) return;
    var s = document.createElement("style");
    s.id = "ann-style";
    s.textContent = [
      "#annCard .ann{position:relative;border:1px solid var(--accent);border-radius:var(--radius);",
      "  background:color-mix(in srgb,var(--accent,#ff7a12) 7%,var(--panel,#140d07));",
      "  padding:14px 16px;margin:14px 0 4px}",
      "#annCard .ann-top{display:flex;align-items:center;gap:10px;margin-bottom:7px;padding-right:26px}",
      "#annCard .ann-tag{font-family:var(--font-head);font-size:9px;letter-spacing:2px;color:#0a0705;",
      "  background:var(--accent-bright);border-radius:3px;padding:2px 7px;flex:none}",
      "#annCard .ann-title{font-family:var(--font-head);font-size:13px;letter-spacing:1.5px;color:var(--accent-bright)}",
      "#annCard .ann-lede{font-size:12px;color:var(--text);line-height:1.55;margin-bottom:11px;padding-right:26px}",
      "#annCard .ann-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:9px;margin-bottom:12px}",
      "#annCard .ann-item{border:1px solid var(--line);border-radius:var(--radius);padding:8px 10px;background:rgba(0,0,0,.22)}",
      "#annCard .ann-h{font-family:var(--font-head);font-size:10px;letter-spacing:1.5px;color:var(--accent-bright);margin-bottom:3px}",
      "#annCard .ann-d{font-size:11px;color:var(--muted);line-height:1.45}",
      "#annCard .ann-foot{display:flex;align-items:center;gap:14px;flex-wrap:wrap}",
      "#annCard .ann-more{font-family:var(--font-head);font-size:10px;letter-spacing:1.5px;",
      "  color:var(--accent-bright);text-decoration:none}",
      "#annCard .ann-more:hover{text-decoration:underline}",
      "#annCard .ann-ok{font-family:var(--font-head);font-size:10px;letter-spacing:1.5px;color:var(--muted);",
      "  background:transparent;border:1px solid var(--accent-dim);border-radius:var(--radius);",
      "  padding:6px 12px;cursor:pointer}",
      "#annCard .ann-ok:hover{border-color:var(--accent);color:var(--accent-bright)}",
      "#annCard .ann-x{position:absolute;top:9px;right:11px;cursor:pointer;color:var(--muted);",
      "  font-size:15px;line-height:1;padding:2px 5px;background:none;border:0}",
      "#annCard .ann-x:hover{color:var(--accent-bright)}",
      "#annCard .ann-x:focus-visible,#annCard .ann-ok:focus-visible{outline:1px solid var(--accent-bright);outline-offset:2px}"
    ].join("");
    document.head.appendChild(s);
  }

  function mount(host) {
    if (!host || seen()) return;                 // dismissed on this device -> never built
    css();
    host.innerHTML =
      '<div class="ann" role="region" aria-label="Release announcement">' +
        '<button class="ann-x" type="button" aria-label="Dismiss announcement">✕</button>' +
        '<div class="ann-top"><span class="ann-tag">' + esc(REL.tag) + "</span>" +
        '<span class="ann-title">' + esc(REL.title) + "</span></div>" +
        '<div class="ann-lede">' + esc(REL.lede) + "</div>" +
        '<div class="ann-grid">' +
          REL.items.map(function (i) {
            return '<div class="ann-item"><div class="ann-h">' + esc(i.h) + "</div>" +
                   '<div class="ann-d">' + esc(i.d) + "</div></div>";
          }).join("") +
        "</div>" +
        '<div class="ann-foot">' +
          '<button class="ann-ok" type="button">GOT IT</button>' +
          '<a class="ann-more" href="' + esc(REL.moreHref) + '">' + esc(REL.moreText) + "</a>" +
        "</div>" +
      "</div>";

    function dismiss() { markSeen(); host.innerHTML = ""; }
    var x = host.querySelector(".ann-x"); if (x) x.addEventListener("click", dismiss);
    var okBtn = host.querySelector(".ann-ok"); if (okBtn) okBtn.addEventListener("click", dismiss);
    // Following the LEARN MORE link counts as having read it — otherwise the pilot comes back
    // from the feature register to the same notice they just acted on.
    var more = host.querySelector(".ann-more"); if (more) more.addEventListener("click", markSeen);
  }

  window.Announce = { mount: mount, _rel: REL, _seen: seen };
})();
