/* devices.js — LINKED REGISTRARS card (approve / revoke a PC's registrar credential)
 *
 * 2026-08-16. Half two of per-device credentials. /ingest/pair is open and can
 * only ASK; this card is Access-gated and is the only thing that can GRANT.
 *
 * The security property lives on the server (functions/blades/api/devices.js):
 * the approver's identity comes from the signed Access JWT and the commander
 * from their own cmdrlink binding, so you can only ever approve a device that
 * asked to be YOU. This file must never imply it can do more than that.
 *
 * ⚠ Shell asset — bump the ?v=N on the <script> tag whenever this file changes,
 * or the edge keeps serving the old copy.
 */
(function () {
  "use strict";

  var POLL_MS = 20000;      // a pairing code lives 10 min; 20s feels instant enough
  var el = null, timer = null;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - (Number(ts) || 0)) / 1000));
    if (s < 60) return s + "s ago";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }

  function say(msg, bad) {
    if (typeof window.toast === "function") { window.toast(msg, bad); return; }
    if (bad) console.warn("[devices] " + msg); else console.log("[devices] " + msg);
  }

  async function api(method, body) {
    var opt = { method: method, credentials: "same-origin" };
    if (body) { opt.headers = { "content-type": "application/json" }; opt.body = JSON.stringify(body); }
    var r = await fetch("/blades/api/devices", opt);
    return await r.json();
  }

  function render(j) {
    if (!el) return;

    if (!j || !j.ok) { el.innerHTML = '<div class="rempty">Could not load devices.</div>'; return; }

    if (!j.bound) {
      el.innerHTML =
        '<div class="rhint">Bind your CMDR name first — a device can only be approved by the ' +
        'commander it asked to be.</div>' +
        '<div class="rempty">No CMDR bound to this login yet.</div>';
      return;
    }

    var h = "";

    // ── pending ────────────────────────────────────────────────────────────
    if (j.pending && j.pending.length) {
      h += '<div class="rhint" style="color:var(--accent-bright,#ffb14e)">' +
           j.pending.length + ' device' + (j.pending.length > 1 ? "s are" : " is") +
           " asking to fly as CMDR " + esc(j.cmdr) + ":</div>";
      j.pending.forEach(function (p) {
        h += '<div class="rempty" style="display:flex;align-items:center;gap:10px;justify-content:space-between">' +
               '<span><b style="letter-spacing:2px">' + esc(p.code) + '</b> — ' + esc(p.device) +
               (p.country ? ' <span style="opacity:.7">(' + esc(p.country) + ')</span>' : "") +
               ' <span style="opacity:.7">' + ago(p.ts) + '</span></span>' +
               '<button class="vg-btn primary" data-approve="' + esc(p.code) + '" ' +
               'style="padding:6px 12px;font-size:11px;cursor:pointer">APPROVE</button>' +
             "</div>";
      });
      // The one piece of copy that actually does security work: a forged pairing
      // attempt surfaces HERE, as a device the pilot doesn't recognise. Say so.
      h += '<div class="rhint" style="opacity:.85">Only approve a code you are looking at on your ' +
           'own PC right now. If you did not start this, decline by ignoring it — it expires in ' +
           '10 minutes and grants nothing meanwhile.</div>';
    }

    // ── approved ───────────────────────────────────────────────────────────
    h += '<div class="rhint" style="margin-top:10px">Linked registrars</div>';
    if (!j.devices || !j.devices.length) {
      h += '<div class="rempty">None yet. Start EDMC and the Registrar will ask — the code appears ' +
           "in its status line.</div>";
    } else {
      j.devices.forEach(function (d) {
        // "Paired 3 weeks ago" is the least useful fact about a PC. What a pilot
        // wants to know is whether it is still reporting — a linked machine that
        // has gone quiet is the one worth a second look.
        var seen = d.stale
          ? '<span style="opacity:.9">⚠ link broken — revoke and pair again</span>'
          : (d.lastSeenTs
              ? "reported " + ago(d.lastSeenTs)
              : "no report yet");
        h += '<div class="rempty" style="display:flex;align-items:center;gap:10px;justify-content:space-between">' +
               "<span>" + esc(d.device) +
               (d.country ? ' <span style="opacity:.7">(' + esc(d.country) + ')</span>' : "") +
               ' <span style="opacity:.7">' + seen + "</span></span>" +
               '<button class="vg-btn" data-revoke="' + esc(d.deviceId) + '" ' +
               'style="padding:6px 12px;font-size:11px;cursor:pointer">REVOKE</button>' +
             "</div>";
      });
      h += '<div class="rhint" style="opacity:.85">Revoking takes effect on that PC\'s next ' +
           "heartbeat — about five seconds.</div>";
    }

    el.innerHTML = h;

    el.querySelectorAll("[data-approve]").forEach(function (b) {
      b.addEventListener("click", function () { approve(b.getAttribute("data-approve"), b); });
    });
    el.querySelectorAll("[data-revoke]").forEach(function (b) {
      b.addEventListener("click", function () { revoke(b.getAttribute("data-revoke"), b); });
    });
  }

  async function load() {
    try { render(await api("GET")); }
    catch (e) { if (el) el.innerHTML = '<div class="rempty">Offline?</div>'; }
  }

  async function approve(code, btn) {
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      var j = await api("POST", { code: code });
      if (j && j.ok) say("device paired ✓"); else say((j && j.error) || "approve failed", true);
    } catch (e) { say("approve failed (offline?)", true); }
    await load();
  }

  async function revoke(deviceId, btn) {
    if (!window.confirm("Revoke this PC? Its Registrar stops reporting until it pairs again.")) return;
    if (btn) { btn.disabled = true; btn.textContent = "…"; }
    try {
      var j = await api("DELETE", { deviceId: deviceId });
      if (j && j.ok) say("device revoked"); else say((j && j.error) || "revoke failed", true);
    } catch (e) { say("revoke failed (offline?)", true); }
    await load();
  }

  window.Devices = {
    mount: function (node) {
      if (!node) return;
      el = node;
      load();
      if (timer) clearInterval(timer);
      // Stop polling when the tab is hidden — this sits on a page pilots leave
      // open on a second monitor for hours.
      timer = setInterval(function () { if (!document.hidden) load(); }, POLL_MS);
    },
    refresh: load,
  };
})();
