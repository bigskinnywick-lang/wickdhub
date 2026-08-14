/* Onyx Blades — THE ADJUTANT · standing orders (replaces companion.js)
 *
 * The Adjutant is the unit assigned to a commander. It is the SITE-SIDE face of the Blades
 * Registrar plugin: the Registrar is the body you fit to your rig, the Adjutant is who you
 * give orders to. Same object, two names on purpose — the plugin's zip, folder and EDMC tab
 * are all "Blades Registrar" and renaming those would break every installed pilot.
 *
 * ONE component, TWO surfaces — deliberately mirroring ob1.js's rule, because the failure
 * mode is identical: build the dashboard card and the record page separately and they drift
 * until the card offers an order the record has never heard of.
 *
 *   Adjutant.mountCard(el, opts)     // MY DASHBOARD — compact, live LEDs, quick toggles
 *   Adjutant.mountOrders(el, opts)   // SERVICE RECORD part III — the full document
 *
 * ── COPY IS FIRST-PERSON IMPERATIVE ────────────────────────────────────────────────────
 * Every row is an ORDER the commander issues, not a feature name: "Sound the alarm when
 * something reads my hold", never "Pirate alarm". Standing orders are imperatives in real
 * service usage, so the voice and the section title justify each other. Keep it that way.
 *
 * ── THE NO-BIND RULE ───────────────────────────────────────────────────────────────────
 * An assist that presses a key cannot work until the pilot has bound that key in Elite. Such
 * an order is BLOCKED from being switched on — not merely styled disabled. Two independent
 * guards, because one of them will eventually be edited:
 *   1. the row renders inert (aria-disabled, no pointer handler path), and
 *   2. commit() refuses a blocked key even if something calls it directly.
 * A dead control that does not say WHY is the bug this rule exists to prevent, so a blocked
 * row always names the exact bind to set.
 *
 * ⚠ ABSENT READINESS FAILS OPEN. `readiness` is {} for pilots on an older plugin that does
 * not report binds. Absent data is NOT evidence of a missing bind — blocking on it would
 * leave those pilots unable to ever switch honk on. Block only on an EXPLICIT ready:false.
 *
 * Styles are injected here rather than added to _shell/blades.css: that file is served with
 * NO ?v= cache-buster, so editing it would serve stale CSS from the edge. Same reasoning as
 * ob1.js. Keep this self-contained until blades.css gets versioned.
 *
 * NOT build-managed. companion.js came out of blades-build/shared/, but blades-build/ now
 * holds only a stale tgz that cannot safely be re-baked, so this ships as a standalone
 * _shell asset like telemetry.js. Bump ?v= on the script tag when you edit it.
 */
(function () {
  "use strict";

  var API = "/blades/api/plugin-settings";
  var POLL_MS = 10000;          // re-poll so a bind set in-game unblocks its order live
  var STATE = null;             // { cmdr, settings, readiness, needsSetup }
  var MOUNTS = [];              // [{ el, kind, opts }] — every surface re-renders together
  var timer = null;

  // Grouped by WHAT THE UNIT DOES, which is also the axis a pilot cares about: does it just
  // watch and tell me, does it touch my controls, or does it file paperwork for me.
  var GROUPS = [
    { sec: "ON WATCH", note: "It watches and tells you. Touches nothing.", rows: [
      { k: "pirate", label: "Sound the alarm when something reads my hold",
        sub: "Klaxon here and on your PC the moment a scan starts. Needs no binds." },
      { k: "fuel", label: "Warn me when I plot a jump and fuel is thin",
        sub: "Under roughly two jumps' worth, or tank below 20%. Not a per-jump stranding check." }
    ]},
    { sec: "AT THE STICK", note: "It presses keys on your machine. These need binds.", rows: [
      { k: "honk", label: "Fire the discovery scanner when I arrive",
        sub: "The honk, on every jump in." },
      { k: "galaxymap", label: "Open the galaxy map and paste the system when I send a NAV",
        sub: "Turns a board click into a plotted route." },
      { k: "refocus", label: "Give me the stick back",
        sub: "Windows only. Returns focus to Elite on your hotkey, and automatically when the alarm fires — an unfocused Elite receives no stick input at all." },
      { k: "refocusact", label: "Put me back in the game when I act on the board",
        sub: "Windows only. After a NAV send or a toggle — never while you are only reading. Ignores anything older than 20s, so a restart can't yank you out of the game for a click from ten minutes ago." }
    ]},
    { sec: "ON THE BOARD", note: "It files for you.", rows: [
      { k: "autocreate", label: "Register a new build when I am the first one here",
        sub: "Raises a Raven build when a site has none. Safeguarded — it waits, in case another Blade logs it first." }
    ]}
  ];

  // Short labels for the dashboard card's chip row. Same keys, same order as GROUPS.
  var CHIP = { pirate: "ALARM", fuel: "FUEL", honk: "HONK", galaxymap: "MAP",
               refocus: "STICK", refocusact: "RETURN", autocreate: "REGISTER" };

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function isOn(k) { return !!(STATE && STATE.settings && STATE.settings[k] === true); }

  // The readiness record for one order, or null when the plugin reported nothing about it.
  // null is NOT "not ready" — see the fail-open note in the header.
  function readyOf(k) {
    var r = STATE && STATE.readiness && STATE.readiness[k];
    return (r && typeof r === "object") ? r : null;
  }

  // ★ THE GUARD. Blocked ONLY on an explicit ready:false from the plugin.
  function blocked(k) {
    var r = readyOf(k);
    return !!r && r.ready === false;
  }

  function missingOf(k) {
    var r = readyOf(k);
    return (r && Array.isArray(r.missing)) ? r.missing : [];
  }

  function bindPhrase(k) {
    var m = missingOf(k);
    if (!m.length) return "a keyboard bind Elite hasn't been given yet";
    if (m.length === 1) return "a keyboard bind for " + m[0];
    return "keyboard binds for " + m.slice(0, -1).join(", ") + " and " + m[m.length - 1];
  }

  function css() {
    if (document.getElementById("adj-style")) return;
    var s = document.createElement("style");
    s.id = "adj-style";
    s.textContent = [
      ".adj-sec{font-family:var(--font-head);font-size:10px;letter-spacing:2px;color:var(--accent);",
      "  text-transform:uppercase;margin:18px 0 2px}",
      ".adj-sec:first-of-type{margin-top:4px}",
      ".adj-secnote{font-size:11px;color:var(--muted);margin:0 0 6px;line-height:1.45}",
      ".adj-row{display:flex;gap:12px;align-items:flex-start;padding:10px 0;border-top:1px solid var(--line)}",
      ".adj-txt{flex:1;min-width:0}",
      ".adj-lab{font-size:12.5px;line-height:1.35}",
      ".adj-sub{font-size:10.5px;color:var(--muted);margin-top:3px;line-height:1.45}",
      ".adj-why{font-size:10.5px;color:var(--bad);margin-top:5px;line-height:1.45}",
      ".adj-why b{color:var(--bad);font-weight:600}",
      ".adj-ctl{flex:0 0 auto;display:flex;align-items:center;gap:8px}",
      ".adj-led{width:9px;height:9px;border-radius:50%;background:#2a1a0c;border:1px solid #000;flex:none;transition:.2s}",
      ".adj-sw{font-family:var(--font-head);font-size:9.5px;letter-spacing:1.5px;color:var(--muted);",
      "  border:1px solid var(--accent-dim);background:var(--panel2,#1c1109);border-radius:7px;",
      "  padding:6px 10px;cursor:pointer;user-select:none;min-width:74px;text-align:center;transition:.15s}",
      ".adj-sw:hover{border-color:var(--accent)}",
      ".adj-sw:focus-visible{outline:1px solid var(--accent-bright);outline-offset:2px}",
      ".adj-row.on .adj-sw{color:var(--good);border-color:var(--good)}",
      ".adj-row.on .adj-led{background:var(--good);box-shadow:0 0 9px var(--good)}",
      // blocked wins over on/off: these rules come last on purpose.
      ".adj-row.blocked .adj-sw{color:var(--bad);border-color:var(--bad);cursor:not-allowed}",
      ".adj-row.blocked .adj-sw:hover{border-color:var(--bad)}",
      ".adj-row.blocked .adj-led{background:var(--bad);box-shadow:0 0 9px var(--bad)}",
      ".adj-row.busy .adj-sw{opacity:.5;pointer-events:none}",
      ".adj-err{color:var(--bad);font-size:11px;margin-top:8px}",
      // ── dashboard card ──
      ".adj-card-head{display:flex;justify-content:space-between;align-items:baseline;gap:10px;margin-bottom:9px}",
      ".adj-count{font-family:var(--font-head);font-size:9px;letter-spacing:1px;color:var(--muted)}",
      ".adj-chips{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px}",
      ".adj-chip{font-family:var(--font-head);font-size:9px;letter-spacing:1px;color:var(--muted);",
      "  border:1px solid var(--line);border-radius:7px;padding:5px 9px;cursor:pointer;user-select:none;transition:.15s}",
      ".adj-chip:hover{border-color:var(--accent)}",
      ".adj-chip:focus-visible{outline:1px solid var(--accent-bright);outline-offset:2px}",
      ".adj-chip.on{color:var(--good);border-color:var(--good)}",
      ".adj-chip.blocked{color:var(--bad);border-color:var(--bad);cursor:not-allowed}",
      ".adj-more{font-family:var(--font-head);font-size:10px;letter-spacing:1px;color:var(--accent-bright);text-decoration:none}",
      ".adj-more:hover{text-decoration:underline}",
      ".adj-warnline{font-size:11px;color:var(--bad);line-height:1.45;margin-bottom:9px}"
    ].join("");
    document.head.appendChild(s);
  }

  function swLabel(k) {
    if (blocked(k)) return "NEEDS BIND";
    return isOn(k) ? "ON" : "OFF";
  }

  function rowHtml(d) {
    var k = d.k, bl = blocked(k), cls = "adj-row" + (isOn(k) ? " on" : "") + (bl ? " blocked" : "");
    var why = bl
      ? '<div class="adj-why">Can\'t be ordered yet — this needs <b>' + esc(bindPhrase(k)) +
        "</b>. Set it in Elite under Controls, then it unlocks here on its own.</div>"
      : "";
    return '<div class="' + cls + '" data-k="' + esc(k) + '">' +
             '<div class="adj-txt"><div class="adj-lab">' + esc(d.label) + "</div>" +
             '<div class="adj-sub">' + esc(d.sub) + "</div>" + why + "</div>" +
             '<div class="adj-ctl"><i class="adj-led"></i>' +
             '<div class="adj-sw" role="switch" tabindex="' + (bl ? "-1" : "0") +
             '" data-k="' + esc(k) + '" aria-checked="' + (isOn(k) ? "true" : "false") + '"' +
             (bl ? ' aria-disabled="true"' : "") + ">" + swLabel(k) + "</div></div></div>";
  }

  function ordersHtml() {
    return GROUPS.map(function (g) {
      return '<div class="adj-sec">' + esc(g.sec) + "</div>" +
             '<div class="adj-secnote">' + esc(g.note) + "</div>" +
             g.rows.map(rowHtml).join("");
    }).join("") + '<div class="adj-err" id="adjErr" hidden></div>';
  }

  function allRows() {
    var out = [];
    GROUPS.forEach(function (g) { g.rows.forEach(function (r) { out.push(r); }); });
    return out;
  }

  function cardHtml(opts) {
    var rows = allRows();
    var onN = 0, blN = 0;
    rows.forEach(function (r) { if (isOn(r.k)) onN++; if (blocked(r.k)) blN++; });
    var chips = rows.map(function (r) {
      var bl = blocked(r.k), on = isOn(r.k);
      return '<div class="adj-chip' + (on ? " on" : "") + (bl ? " blocked" : "") +
             '" role="switch" tabindex="' + (bl ? "-1" : "0") + '" data-k="' + esc(r.k) +
             '" aria-checked="' + (on ? "true" : "false") + '"' + (bl ? ' aria-disabled="true"' : "") +
             ' title="' + esc(r.label) + '">' + (on ? "●" : bl ? "●" : "○") + " " +
             esc(CHIP[r.k] || r.k.toUpperCase()) + "</div>";
    }).join("");
    var warn = blN
      ? '<div class="adj-warnline">' + blN + (blN === 1 ? " order needs" : " orders need") +
        " a keyboard bind before it can be given.</div>"
      : "";
    var href = (opts && opts.recordHref) || "/blades/record/";
    // `compact` drops this component's own <h2> for hosts that supply the row chrome
    // themselves — the ASSIGNMENTS card, where the Adjutant is a row rather than a card.
    // Additive: the default is exactly the standalone card as before.
    var compact = !!(opts && opts.compact);
    return '<div class="adj-card-head">' +
           (compact ? "<span></span>" : '<h2 style="margin:0">◈ ADJUTANT</h2>') +
           '<span class="adj-count">' + onN + " OF " + rows.length + " STANDING" +
           (blN ? " · " + blN + " BLOCKED" : "") + "</span></div>" +
           warn + '<div class="adj-chips">' + chips + "</div>" +
           '<a class="adj-more" href="' + esc(href) + '">FULL STANDING ORDERS ▸</a>' +
           '<div class="adj-err" id="adjCardErr" hidden></div>';
  }

  function head(kind, opts) {
    if (kind !== "card" || (opts && opts.compact)) return "";
    return '<div class="adj-card-head"><h2 style="margin:0">◈ ADJUTANT</h2></div>';
  }

  function signedOutHtml(kind, opts) {
    return head(kind, opts) + '<div class="rempty">' +
      (kind === "card" ? "Sign in to give orders." : "Sign in to see your standing orders.") + "</div>";
  }

  function setupHtml(kind, opts) {
    return head(kind, opts) + '<div class="rempty">Bind your CMDR name first — the Adjutant ' +
      "is assigned to a commander, not to a login.</div>";
  }

  function paint() {
    MOUNTS.forEach(function (m) {
      if (!m.el || !document.contains(m.el)) return;
      if (!STATE) { m.el.innerHTML = signedOutHtml(m.kind, m.opts); return; }
      if (STATE.needsSetup) { m.el.innerHTML = setupHtml(m.kind, m.opts); return; }
      m.el.innerHTML = (m.kind === "card") ? cardHtml(m.opts) : ordersHtml();
    });
  }

  function get() {
    return fetch(API, { credentials: "same-origin", cache: "no-store" })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error("bad payload");
        STATE = j;
        paint();
        return j;
      })
      .catch(function () {
        // Not signed in, or the route is unreachable. Render NOTHING about any commander —
        // these surfaces are mounted on pages a signed-out visitor can reach.
        STATE = null;
        paint();
        return null;
      });
  }

  function showErr(msg) {
    ["adjErr", "adjCardErr"].forEach(function (id) {
      var e = document.getElementById(id);
      if (e) { e.textContent = msg; e.hidden = !msg; }
    });
  }

  function commit(k, next) {
    // GUARD 2 of 2. The row is already inert; this refuses even a direct call, so a future
    // edit to the rendering cannot quietly turn a blocked order into a live write.
    if (blocked(k)) return;
    if (!STATE || !STATE.settings) return;
    var prev = !!STATE.settings[k];
    STATE.settings[k] = next;            // optimistic
    paint();
    var body = {}; body[k] = next;
    fetch(API, {
      method: "POST", credentials: "same-origin",
      headers: { "content-type": "application/json" }, body: JSON.stringify(body)
    })
      .then(function (r) { if (!r.ok) throw new Error("http " + r.status); return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.settings) throw new Error("bad payload");
        // Re-assert from the SERVER's copy, not from what we hoped we set.
        STATE.settings = j.settings;
        paint();
        showErr("");
      })
      .catch(function () {
        STATE.settings[k] = prev;        // revert
        paint();
        showErr("Couldn't send that order — nothing changed. Try again in a moment.");
      });
  }

  function hit(ev) {
    var t = ev.target;
    if (!t || !t.closest) return;
    var el = t.closest(".adj-sw, .adj-chip");
    if (!el) return;
    if (ev.type === "keydown" && ev.key !== " " && ev.key !== "Enter") return;
    ev.preventDefault();
    if (el.getAttribute("aria-disabled") === "true") return;   // GUARD 1 of 2
    var k = el.getAttribute("data-k");
    if (!k) return;
    commit(k, !isOn(k));
  }

  function startPolling() {
    if (timer) return;
    // A pilot who alt-tabs out to set a bind in Elite comes back to a row that has unblocked
    // itself. Without this the fix requires a reload, which nobody thinks to do.
    timer = setInterval(function () {
      if (document.hidden) return;
      get();
    }, POLL_MS);
  }

  function mount(el, kind, opts) {
    if (!el) return;
    css();
    el.classList.add("adj");
    el.innerHTML = '<div class="rempty">Loading…</div>';
    MOUNTS.push({ el: el, kind: kind, opts: opts || {} });
    el.addEventListener("click", hit);
    el.addEventListener("keydown", hit);
    get();
    startPolling();
  }

  window.Adjutant = {
    mountCard: function (el, opts) { mount(el, "card", opts); },
    mountOrders: function (el, opts) { mount(el, "orders", opts); },
    refresh: get,
    _blocked: blocked,          // exported for the harness
    _groups: GROUPS
  };
})();
