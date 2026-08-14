/* Onyx Blades — Form OB-1 · disclosure + consent (phase 2)
 *
 * ONE component, TWO entry points. Shown once at enlistment, and thereafter IS the member's
 * dossier settings panel. Building it twice is how the two drift until the notice promises
 * something the settings screen doesn't do.
 *
 *   OB1.mount(el, { mode: "settings" })   // live now — the dossier panel
 *   OB1.mount(el, { mode: "enlist" })     // wired, not routed yet — phase 6 publishes the card
 *
 * ── THE RULE THAT GOVERNS THIS FILE ────────────────────────────────────────────────────
 * The card describes behaviour. Until the behaviour exists, the card is a promise being
 * broken. Section III (real-world data) is therefore rendered PREVIEW · NOT YET ACTIVE and
 * its control is INERT — not merely styled disabled. A disabled control that still posts a
 * value is the standard version of that bug, so `list_rig` is never sent, and the server
 * rejects it anyway. Two independent guards, because one of them will eventually be edited.
 *
 * Styles are injected here rather than added to _shell/blades.css: that file is loaded with
 * NO ?v= cache-buster, so editing it would serve stale CSS from the edge with no way to
 * force a refresh. Keep this self-contained until blades.css gets versioned.
 */
(function () {
  "use strict";

  var REV = 1;                 // bump ONLY on a material change; see the amendment policy
  var API = "/blades/api/member";

  // Live preferences. `list_rig` is deliberately NOT here — it is preview-only copy below.
  var PREFS = [
    { key: "show_on_roster",       label: "Show my CMDR name on the squadron roster",
      help: "Off: you still count in every squadron total, you just aren't named." },
    { key: "link_discord_public",  label: "Show my Discord handle beside my name",
      help: "Off by default. Many pilots fly in character, and a handle leads places a CMDR name doesn't." },
    { key: "show_activity",        label: "Show my activity and usual flight hours",
      help: "Lets other members know when you're likely to be flying." },
    { key: "credit_contributions", label: "Credit my contributions by name on the boards",
      help: "Off: your hauling still counts toward squadron totals, logged without your name." }
  ];

  function css() {
    if (document.getElementById("ob1-style")) return;
    var s = document.createElement("style");
    s.id = "ob1-style";
    s.textContent = [
      ".ob1 .ob1-lede{font-size:12px;color:var(--muted);line-height:1.55;margin:-4px 0 14px}",
      ".ob1 .ob1-plain{border:1px solid var(--accent-dim);border-radius:var(--radius);padding:10px 12px;",
      "  font-size:12px;line-height:1.5;color:var(--text);background:rgba(0,0,0,.25);margin:0 0 16px}",
      ".ob1 .ob1-plain b{color:var(--accent-bright)}",
      ".ob1 .ob1-sec{font-family:var(--font-head);font-size:10px;letter-spacing:2px;color:var(--accent);",
      "  text-transform:uppercase;margin:18px 0 8px;display:flex;align-items:center;gap:8px}",
      ".ob1 .ob1-tag{font-family:var(--font-body);letter-spacing:1px;font-size:9px;border:1px solid var(--warn);",
      "  color:var(--warn);padding:1px 6px;border-radius:2px;text-transform:none}",
      ".ob1 .ob1-row{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}",
      ".ob1 .ob1-row:first-of-type{border-top:0}",
      ".ob1 .ob1-txt{flex:1;min-width:0}",
      ".ob1 .ob1-lab{font-size:12.5px;line-height:1.35}",
      ".ob1 .ob1-help{font-size:10.5px;color:var(--muted);margin-top:3px;line-height:1.45}",
      ".ob1 .ob1-sw{flex:0 0 auto;width:44px;height:24px;border:1px solid var(--accent-dim);border-radius:14px;",
      "  background:#0b0704;position:relative;cursor:pointer;transition:border-color .15s}",
      ".ob1 .ob1-sw>i{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;",
      "  background:var(--muted);transition:transform .15s,background .15s}",
      ".ob1 .ob1-sw[aria-checked=true]{border-color:var(--accent)}",
      ".ob1 .ob1-sw[aria-checked=true]>i{transform:translateX(20px);background:var(--accent-bright);box-shadow:0 0 10px var(--glow)}",
      ".ob1 .ob1-sw[aria-disabled=true]{opacity:.4;cursor:not-allowed}",
      ".ob1 .ob1-sw:focus-visible{outline:1px solid var(--accent-bright);outline-offset:2px}",
      ".ob1 .ob1-foot{margin-top:16px;font-size:10px;color:var(--muted);letter-spacing:1px;",
      "  display:flex;justify-content:space-between;gap:10px;flex-wrap:wrap}",
      ".ob1 .ob1-err{color:var(--bad);font-size:11px;margin-top:8px}"
    ].join("");
    document.head.appendChild(s);
  }

  // FAIL-CLOSED. A preference counts only when it is exactly true. undefined, null, "true"
  // and 1 all mean NO. Existing members, partial writes and fields added later all arrive as
  // undefined, and every one of them is an exposure if this check is loosened.
  function on(prefs, key) { return !!prefs && prefs[key] === true; }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function sw(key, checked, disabled) {
    return '<div class="ob1-sw" role="switch" tabindex="' + (disabled ? "-1" : "0") +
           '" data-k="' + esc(key) + '" aria-checked="' + (checked ? "true" : "false") + '"' +
           (disabled ? ' aria-disabled="true"' : "") + "><i></i></div>";
  }

  // `opts` is ADDITIVE and defaults to exactly the pre-existing output — the retail dossier
  // panel calls mount() with no opts and must render byte-identically. Added 2026-08-13 so
  // the Service Record page can host these sections inside its own document chrome without
  // a second copy of PREFS; two copies is precisely the drift this file was written to stop.
  //   headless : suppress this component's own <h2> and lede (the page supplies them)
  //   numerals : renumber the sections, e.g. real-world data becomes IV when standing
  //              orders are inserted ahead of it
  //   slot     : HTML inserted BETWEEN the visibility rows and the real-world section, so
  //              another component (the Adjutant's standing orders) can occupy a numbered
  //              part of the same document. A slot rather than DOM surgery after the fact
  //              because this component renders asynchronously — anything that waits for
  //              the fetch to land is a race.
  //   onRender : called with (host) immediately after innerHTML is set, which is when a
  //              slot's contents exist and can be mounted into. Also the ONLY safe moment;
  //              a caller that mounts on its own timer is racing the fetch.
  function render(host, state, mode, opts) {
    opts = opts || {};
    var headless = !!opts.headless;
    var N = opts.numerals || {};
    var nWho = N.who || "I", nSees = N.sees || "II", nReal = N.real || "III";
    var m = state.member || {}, p = m.prefs || {};
    var rows = PREFS.map(function (d) {
      return '<div class="ob1-row"><div class="ob1-txt"><div class="ob1-lab">' + esc(d.label) +
             '</div><div class="ob1-help">' + esc(d.help) + "</div></div>" + sw(d.key, on(p, d.key), false) + "</div>";
    }).join("");

    host.className = "ob1";
    host.innerHTML =
      (headless ? "" :
        '<h2>◈ Form OB-1 · Your Record' + (mode === "enlist" ? "" : '<span class="h2r">REV ' + REV + "</span>") + "</h2>" +
        '<div class="ob1-lede">What the hub keeps about you, and what other members can see. ' +
        "Change any of it whenever you like — it takes effect immediately.</div>") +

      '<div class="ob1-plain">In plain terms: we record what you do <b>in game</b> for the squadron — ' +
      "builds, hauling, claims, when you're flying. " +
      (state.rigFeatureLive ? "" : "<b>We hold no real-world data about you at all.</b> ") +
      "Nothing here is visible to the public web; the roster is for enlisted members only.</div>" +

      '<div class="ob1-sec">' + nWho + ' · Who you are</div>' +
      '<div class="ob1-row"><div class="ob1-txt"><div class="ob1-lab">CMDR ' + esc(state.cmdr || "—") +
      '</div><div class="ob1-help">Your commander name, as bound to this account.</div></div></div>' +
      '<div class="ob1-row"><div class="ob1-txt"><div class="ob1-lab">Discord: ' + esc(m.discord || "not set") +
      '</div><div class="ob1-help">Held for squadron ops. Shown to other members only if you allow it below. ' +
      "The Admiral's Desk can always see it for ops — that's command access, not display.</div></div></div>" +

      '<div class="ob1-sec">' + nSees + ' · What other members see</div>' + rows +

      (opts.slot || "") +

      '<div class="ob1-sec">' + nReal + ' · Real-world data <span class="ob1-tag">PREVIEW · NOT YET ACTIVE</span></div>' +
      '<div class="ob1-plain">This section covers anything about <b>the person at the desk</b> rather than the ' +
      "commander — starting with your flight rig. <b>Nothing here is being collected today.</b> Whenever " +
      "something is added to this category it is always volunteered, always optional, never public, and " +
      "destroyed when you leave.</div>" +
      '<div class="ob1-row"><div class="ob1-txt"><div class="ob1-lab">List my flight rig in the Systems Register' +
      '</div><div class="ob1-help">Not yet available — this control is inactive and stores nothing.</div></div>' +
      sw("list_rig", false, true) + "</div>" +

      '<div class="ob1-foot"><span>STATUS: ' + esc(m.status || "ACTIVE") + "</span><span>REV " + REV +
      " · changes save as you make them</span></div>" +
      '<div class="ob1-err" id="ob1Err" hidden></div>';
  }

  function mount(host, opts) {
    if (!host) return;
    opts = opts || {};
    var mode = opts.mode || "settings";
    css();
    host.className = "ob1";
    host.innerHTML = (opts.headless ? "" : "<h2>◈ Form OB-1 · Your Record</h2>") +
                     '<div class="rempty">Loading…</div>';

    var state = null;

    fetch(API, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error("bad payload");
        state = j;
        render(host, state, mode, opts);
        if (typeof opts.onRender === "function") { try { opts.onRender(host); } catch (e) {} }
      })
      .catch(function () {
        // Not signed in, or the route is unreachable. Render NOTHING about any member —
        // this component is mounted on pages that are publicly readable.
        host.className = "ob1";
        host.innerHTML = (opts.headless ? "" : "<h2>◈ Form OB-1 · Your Record</h2>") +
                         '<div class="rempty">Sign in to view your record.</div>';
      });

    function commit(el, key, next) {
      var prev = el.getAttribute("aria-checked") === "true";
      el.setAttribute("aria-checked", next ? "true" : "false");   // optimistic
      var body = { prefs: {} };
      body.prefs[key] = next;
      fetch(API, {
        method: "PATCH", credentials: "same-origin",
        headers: { "content-type": "application/json" }, body: JSON.stringify(body)
      })
        .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
        .then(function (j) {
          if (!j || !j.ok) throw new Error("bad payload");
          state.member = j.member;
          // Re-assert from the SERVER's copy, not from what we hoped we set. If the server
          // rejected or normalised the value, the switch must show the truth.
          el.setAttribute("aria-checked", on(j.member.prefs, key) ? "true" : "false");
          var e = document.getElementById("ob1Err"); if (e) e.hidden = true;
        })
        .catch(function () {
          el.setAttribute("aria-checked", prev ? "true" : "false");   // revert
          var e = document.getElementById("ob1Err");
          if (e) { e.textContent = "Couldn't save that — your setting is unchanged. Try again in a moment."; e.hidden = false; }
        });
    }

    function hit(ev) {
      var el = ev.target.closest ? ev.target.closest(".ob1-sw") : null;
      if (!el || !host.contains(el)) return;
      if (el.getAttribute("aria-disabled") === "true") return;   // inert: no write, ever
      var key = el.getAttribute("data-k");
      if (!key || key === "list_rig") return;                    // second guard, on purpose
      if (ev.type === "keydown" && ev.key !== " " && ev.key !== "Enter") return;
      ev.preventDefault();
      commit(el, key, el.getAttribute("aria-checked") !== "true");
    }
    host.addEventListener("click", hit);
    host.addEventListener("keydown", hit);
  }

  window.OB1 = { mount: mount, REV: REV, _on: on };
})();
