/* Onyx Blades — ASSIGNMENTS · the keyring card
 *
 * "What you've been issued and where you sit." One card, sitting ABOVE the site selector on
 * MY DASHBOARD, holding two things that were previously scattered:
 *
 *   YOUR UNIT  — the Adjutant (mounted from adjutant.js, never re-implemented here)
 *   OFFICES    — one row per desk the viewer actually holds
 *
 * ── WHY THIS EXISTS ────────────────────────────────────────────────────────────────────
 * Four chips lived in `.buildbar` — ◆ ARCHITECT, ⚙ ADMIN, ⚓ ADMIRAL'S DESK, ◷ NET USAGE.
 * None of them is a CONTROL; they are DOORS, sitting in a row that is otherwise about
 * choosing which build site you are looking at. Mixing "pick a thing" with "go somewhere"
 * is what made the dashboard feel cluttered. The doors move here; the buildbar goes back to
 * being the site selector.
 *
 * ── KEYRING, NOT KEY CABINET ───────────────────────────────────────────────────────────
 * This card is the pilot's KEYRING: keys to offices they HOLD. The forthcoming Owner Desk is
 * the KEY CABINET: a key to every office that EXISTS, including ones the viewer does not
 * hold, for testing them. Opening an office from the cabinet must PREVIEW it (see exactly
 * what its holder sees, WITHOUT its authority) — if it silently granted authority we would
 * permanently lose the ability to answer "what can a real admiral actually do?", which is
 * the only reason to build the cabinet at all. That belongs in the cabinet, NOT here.
 *
 * ⚠ NO OWNER DESK ROW YET, ON PURPOSE. `/blades/owner/` does not exist. A card that offers a
 * door to an empty room is the same broken promise ob1.js refuses to make about features it
 * hasn't built. The row appears when the page does.
 *
 * ── GATES ARE COPIED, NOT REDESIGNED ───────────────────────────────────────────────────
 * Each row reproduces EXACTLY the reveal condition that chip had in commander/index.html, so
 * this is a layout change and nothing else. Changing who can reach a desk inside a layout
 * commit is how an access change ships unnoticed.
 *   architect : everyone (it was never gated)
 *   admin     : isAdmin
 *   usage     : isAdmin
 *   admiral   : isAdmin || isAdmiral   <-- inherited as-is; see the note on that row
 *
 * One `/blades/api/admins` fetch serves all of them. The commander page previously called
 * that endpoint TWICE (once for admin+usage, once for admiral) — this collapses it.
 *
 * NOT build-managed. Standalone _shell asset like telemetry.js and adjutant.js; bump the ?v=
 * on the script tag when you edit it. See project_blades_build_drift.
 */
(function () {
  "use strict";

  var WHOAMI = "/blades/api/admins";

  // holds(w) receives the whoami payload: { me, isAdmin, isOwner, isAdmiral, ... }
  var DESKS = [
    { k: "architect", icon: "◆", name: "Architect deck", href: "/blades/architect/",
      sub: "Your claims, primary-port windows and cleanup",
      holds: function () { return true; } },

    { k: "admin", icon: "⚙", name: "Admin console", href: "/blades/admin/",
      sub: "Build registry, backups, integrity — technical operations",
      holds: function (w) { return !!w.isAdmin; } },

    { k: "usage", icon: "◷", name: "Net usage", href: "/blades/usage/",
      sub: "Squad net traffic and KV at a glance",
      holds: function (w) { return !!w.isAdmin; } },

    // ⚠ INHERITED BEHAVIOUR, FLAGGED: an ADMIN currently sees the Admiral's Desk. Under the
    // domain-lane model (admin = technical, admiral = command) that conflates two lanes, and
    // the roles design says visibility should follow WORN roles rather than authority. It is
    // reproduced here unchanged on purpose — this commit moves chips, it does not re-gate
    // anything. Tightening it to `!!w.isAdmiral` is a one-word change when Adam calls it.
    { k: "admiral", icon: "⚓", name: "Admiral's desk", href: "/blades/admiral/",
      sub: "Command — the squadron welcome message",
      holds: function (w) { return !!(w.isAdmin || w.isAdmiral); } }
  ];

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function css() {
    if (document.getElementById("asg-style")) return;
    var s = document.createElement("style");
    s.id = "asg-style";
    s.textContent = [
      ".asg-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin:0 0 4px}",
      ".asg-sub{font-size:11px;color:var(--muted);margin:0 0 12px;line-height:1.45}",
      ".asg-sec{font-family:var(--font-head);font-size:9.5px;letter-spacing:2px;color:var(--accent);",
      "  text-transform:uppercase;margin:14px 0 6px;padding-top:12px;border-top:1px solid var(--line)}",
      ".asg-sec:first-of-type{margin-top:0;padding-top:0;border-top:0}",
      ".asg-desk{display:flex;align-items:center;gap:11px;padding:9px 10px;margin-bottom:6px;",
      "  border:1px solid var(--line);border-radius:var(--radius);text-decoration:none;color:var(--text);",
      "  transition:border-color .15s,background .15s}",
      ".asg-desk:hover{border-color:var(--accent);background:rgba(0,0,0,.2)}",
      ".asg-desk:focus-visible{outline:1px solid var(--accent-bright);outline-offset:2px}",
      ".asg-ico{flex:0 0 auto;font-size:14px;color:var(--accent-bright);width:18px;text-align:center}",
      ".asg-txt{flex:1;min-width:0}",
      ".asg-name{font-family:var(--font-head);font-size:11px;letter-spacing:1.5px;color:var(--accent-bright)}",
      ".asg-desc{font-size:10.5px;color:var(--muted);margin-top:2px;line-height:1.4}",
      ".asg-go{flex:0 0 auto;color:var(--muted);font-size:12px}",
      ".asg-desk:hover .asg-go{color:var(--accent-bright)}",
      ".asg-none{font-size:11px;color:var(--muted);line-height:1.5}"
    ].join("");
    document.head.appendChild(s);
  }

  function deskHtml(d) {
    return '<a class="asg-desk" href="' + esc(d.href) + '" data-desk="' + esc(d.k) + '">' +
             '<span class="asg-ico">' + esc(d.icon) + "</span>" +
             '<span class="asg-txt"><span class="asg-name">' + esc(d.name) + "</span>" +
             '<span class="asg-desc">' + esc(d.sub) + "</span></span>" +
             '<span class="asg-go">▸</span></a>';
  }

  function paintDesks(host, who) {
    var slot = host.querySelector(".asg-offices");
    if (!slot) return;
    var held = DESKS.filter(function (d) { return d.holds(who || {}); });
    slot.innerHTML = held.length
      ? held.map(deskHtml).join("")
      : '<div class="asg-none">No offices assigned. Your Adjutant is above.</div>';
  }

  function mount(host, opts) {
    if (!host) return;
    opts = opts || {};
    css();

    // Frame renders SYNCHRONOUSLY so the Adjutant slot exists before anything async starts.
    // adjutant.js owns its own fetch and its own polling; this card never duplicates either.
    host.innerHTML =
      '<div class="asg-head"><h2 style="margin:0">◈ ASSIGNMENTS</h2></div>' +
      '<div class="asg-sub">What you have been issued, and where you sit.</div>' +
      '<div class="asg-sec">Your unit</div>' +
      '<div class="asg-unit"></div>' +
      '<div class="asg-sec">Offices</div>' +
      '<div class="asg-offices"><div class="asg-none">Checking your postings…</div></div>';

    if (window.Adjutant) {
      window.Adjutant.mountCard(host.querySelector(".asg-unit"),
        { compact: true, recordHref: opts.recordHref });
    }

    fetch(WHOAMI, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (w) { paintDesks(host, w || {}); })
      .catch(function () {
        // Signed out or unreachable. Fail CLOSED to the ungated set — never guess a desk
        // into existence for someone whose identity we could not read.
        paintDesks(host, {});
      });
  }

  window.Assignments = { mount: mount, _desks: DESKS };
})();
