#!/usr/bin/env python3
"""Activation-driven refocus — the gate that decides when the board may steal the foreground (b3.21).

    python3 tests/refocus-activation.test.py

Imports the REAL plugin source with the EDMC surface stubbed and a controllable clock, then
drives `_rf_activate` and `_apply_srv` directly. `_refocus_to_elite` is replaced with a
recorder, so these tests assert on THE DECISION — which is the whole feature. Whether Windows
then grants the foreground is a separate question that only the rig can answer.

⚠ WHAT THIS FILE IS GUARDING AGAINST, in order of how much it would cost:

  1. **Stealing focus while Adam is reading.** The entire point. Every "must not fire" case
     below is worth more than the "must fire" ones, so they outnumber them deliberately.
  2. **Replay.** Two independent ways a stale action looks new: a nav record still inside its
     600s KV TTL after `_nav["last_ts"]` resets on restart, and a settings change that
     happened while the plugin was off. Different mechanisms, different gates, both tested.
  3. **A gate that cannot fail.** Every threshold here is asserted against an ABSOLUTE value,
     never against the constant it is testing. `tests/pirate-alarm.test.py` records how that
     bit us: a TTL test that advanced the clock BY the TTL moved with the constant and stayed
     green when the constant was set to 1e12. Mutation-test any change to this file the same
     way — break the constant, watch a test go red. If none does, the test is decoration.
"""
import os
LOADPY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                      "plugin-src", "BladesRegistrar", "load.py")
import sys, types, importlib.util, urllib.request


def load():
    for n in ["myNotebook", "config", "theme", "plug", "l10n", "EDMCLogging", "monitor",
              "ttkHyperlinkLabel"]:
        sys.modules[n] = types.ModuleType(n)
    sys.modules["config"].config = types.SimpleNamespace(
        get_str=lambda *a, **k: "", get_int=lambda *a, **k: 0, get_bool=lambda *a, **k: False,
        set=lambda *a, **k: None, appversion=lambda: "5.0")
    sys.modules["config"].appname = "EDMC"
    for k in list(sys.modules):
        if k == "load":
            del sys.modules[k]
    spec = importlib.util.spec_from_file_location("load", LOADPY)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)

    def boom(*a, **k):
        raise RuntimeError("network blocked in test")
    urllib.request.urlopen = boom

    # The recorder. _rf_activate's job is to DECIDE; this captures the decision.
    # ⚠ Keep a handle on the REAL function first. This stub is what makes every gate test
    # above possible — and it is also exactly what hid the b3.25 bug, because no test ever
    # executed _refocus_to_elite's own return paths. Section 5c restores this handle to test
    # them. A stub that stands in for the thing under test must always leave a way back.
    m.moved = []
    m._orig_refocus_to_elite = m._refocus_to_elite
    m._refocus_to_elite = lambda why="": (m.moved.append(why), True)[1]
    m._set_status = lambda *a, **k: None
    m._srv_path = lambda: os.devnull          # never persist during tests

    class T:
        now = 1_000_000.0

        def time(self):
            return T.now

        def sleep(self, *a):
            pass

        def __getattr__(self, k):
            import time as _t
            return getattr(_t, k)
    m.time = T()
    m._T = T
    # os.name is read at call time; pretend Windows so the gate is exercised at all.
    m.os = types.SimpleNamespace(**{k: getattr(os, k) for k in dir(os) if not k.startswith("_")})
    m.os.name = "nt"
    return m


R = []


def ok(name, cond, detail=""):
    R.append((name, bool(cond), detail))


def fresh(primed=True, act_on=True):
    """A module in the steady state: past startup, feature on, cooldown clear."""
    m = load()
    m._srv["refocusact"] = act_on
    m._rfa["primed"] = primed
    m._rfa["last"] = 0.0
    m.moved[:] = []
    return m


# ── 1. it fires when it should ────────────────────────────────────────────────
m = fresh()
r = m._rf_activate("nav", 2.0)
ok("nav 2s old refocuses", r and m.moved == ["board:nav"], m._rfa["why"])

m = fresh()
r = m._rf_activate("toggle")
ok("toggle (no age) refocuses", r and m.moved == ["board:toggle"], m._rfa["why"])

# The window is sized ABOVE the 5s poll interval on purpose — an honest click observed on a
# slow poll must still count. Absolute value, not RF_ACT_MAX_AGE_S - 1.
m = fresh()
ok("a 12s-old nav still counts (poll interval + slack)",
   m._rf_activate("nav", 12.0) and m.moved == ["board:nav"], m._rfa["why"])


# ── 2. NEGATIVE CONTROLS — the cases that protect Adam's attention ────────────
# Absolute ages. 600.0 is the KV TTL of a nav record: the exact replay this gate exists for.
m = fresh()
r = m._rf_activate("nav", 600.0)
ok("CONTROL replay: a 10-minute-old nav push does NOT refocus",
   (not r) and m.moved == [] and "stale" in m._rfa["why"], m._rfa["why"])

m = fresh()
r = m._rf_activate("nav", 25.0)
ok("CONTROL a 25s-old nav does NOT refocus", (not r) and m.moved == [], m._rfa["why"])

# Feature off must beat everything else, including a perfectly fresh action.
m = fresh(act_on=False)
r = m._rf_activate("nav", 0.5)
ok("CONTROL toggle off: fresh nav does NOT refocus",
   (not r) and m.moved == [] and m._rfa["why"] == "off", m._rfa["why"])

# The startup replay: plugin was off while things changed. First poll is baseline only.
m = fresh(primed=False)
r = m._rf_activate("toggle")
ok("CONTROL startup: first poll does NOT refocus",
   (not r) and m.moved == [] and "startup" in m._rfa["why"], m._rfa["why"])

# An older worker sends no `now`, so age cannot be computed. Fail CLOSED.
m = fresh()
r = m._rf_activate("nav", m._RF_AGE_UNKNOWN)
ok("CONTROL unknown age fails closed (no refocus)",
   (not r) and m.moved == [] and "unknown" in m._rfa["why"], m._rfa["why"])

m = fresh()
r = m._rf_activate("nav", float("nan"))
ok("CONTROL NaN age fails closed", (not r) and m.moved == [], m._rfa["why"])

# Not Windows: the key-sending/foreground assists do not apply at all.
m = fresh()
m.os.name = "posix"
r = m._rf_activate("nav", 1.0)
ok("CONTROL non-Windows does NOT refocus", (not r) and m.moved == [], m._rfa["why"])


# ── 3. burst → one refocus, then the cooldown lets go ────────────────────────
m = fresh()
m._rf_activate("toggle")
m._rf_activate("toggle")
m._rf_activate("toggle")
ok("CONTROL a burst of 3 toggles refocuses ONCE", m.moved == ["board:toggle"], str(m.moved))

# Absolute clock move, well past the 8s cooldown — not "RF_ACT_COOLDOWN_S + 1".
m._T.now += 30.0
m._rf_activate("toggle")
ok("cooldown releases after 30s", m.moved == ["board:toggle", "board:toggle"], str(m.moved))


# ── 4. _apply_srv is the toggle trigger, and only on a REAL change ────────────
m = fresh()
m._srv.update({k: None for k in m._SRV_KEYS})
m._srv["refocusact"] = True
m._rfa["primed"] = True
m.moved[:] = []
m._apply_srv({"honk": True})
ok("flipping an assist on the board refocuses", m.moved == ["board:toggle"], str(m.moved))

m.moved[:] = []
m._T.now += 30.0
m._apply_srv({"honk": True})          # same value redelivered every 5s poll, forever
ok("CONTROL an UNCHANGED settings poll does NOT refocus", m.moved == [], str(m.moved))

# Turning the feature OFF must not itself be an activation — the check reads the NEW value.
m = fresh()
m._srv["refocusact"] = True
m._T.now += 30.0
m.moved[:] = []
m._apply_srv({"refocusact": False})
ok("CONTROL switching the feature off does not refocus on the way out",
   m.moved == [], str(m.moved))


# ── 5. passive traffic can never reach the gate ───────────────────────────────
# Telemetry, alerts and readiness ride the same heartbeat. They must not be activations.
# This asserts on the module's own wiring rather than on a comment: if a future change routes
# any of them through _apply_srv or _rf_activate, this goes red.
m = fresh()
m.moved[:] = []
m._apply_srv({})                       # empty settings — what a quiet poll delivers
m._apply_srv(None)                     # what a pilot with no saved settings delivers
ok("CONTROL quiet polls (empty/None settings) do NOT refocus", m.moved == [], str(m.moved))

src = open(LOADPY, encoding="utf-8").read()
ok("CONTROL nothing in the telemetry/alerts path calls the gate",
   "_rf_activate" not in src.split("def _assist_telemetry")[-1].split("def ")[0]
   and src.count("_rf_activate(") == 4,          # 1 def + nav + toggle + back-to-game button
   "call sites: %d" % src.count("_rf_activate("))


# ── 5b. the BACK TO GAME button: explicit intent, gated differently (b3.22) ──
# It skips the opt-in, priming and cooldown — and MUST still respect freshness, because
# replay is a property of the transport, not of how deliberate the pilot was.
m = fresh(act_on=False)                      # refocusact OFF
r = m._rf_activate("button:button", 1.0, explicit=True)
ok("explicit press works even with refocusact OFF",
   r and m.moved == ["board:button:button"], m._rfa["why"])

m = fresh(primed=False, act_on=False)        # first poll after an EDMC restart
r = m._rf_activate("button:button", 1.0, explicit=True)
ok("explicit press works on the very first poll", r and m.moved != [], m._rfa["why"])

m = fresh(act_on=False)
m._rf_activate("button:button", 1.0, explicit=True)
m._rf_activate("button:button", 1.0, explicit=True)
ok("explicit press is NOT swallowed by the cooldown (a second press means try again)",
   len(m.moved) == 2, str(m.moved))

# The one gate it keeps. 600s = the nav TTL; act's own TTL is 60s, so this is well beyond both.
m = fresh(act_on=False)
r = m._rf_activate("button:button", 600.0, explicit=True)
ok("CONTROL explicit press still refuses a REPLAYED action",
   (not r) and m.moved == [] and "stale" in m._rfa["why"], m._rfa["why"])

m = fresh(act_on=False)
r = m._rf_activate("button:button", m._RF_AGE_UNKNOWN, explicit=True)
ok("CONTROL explicit press with an uncomputable age fails closed",
   (not r) and m.moved == [], m._rfa["why"])

# Non-Windows is a hard floor for every path, explicit included.
m = fresh(act_on=False)
m.os.name = "posix"
r = m._rf_activate("button:button", 1.0, explicit=True)
ok("CONTROL explicit press does nothing on non-Windows", (not r) and m.moved == [], m._rfa["why"])


# ── 5c. _refocus_to_elite must REPORT AN OUTCOME on every path (b3.25 regression) ──
# ★ THIS IS THE TEST THAT WAS MISSING, and its absence cost a shipped-broken feature.
# Everything above stubs `_refocus_to_elite` with a recorder, so the function's own paths were
# never executed by any test. The "Elite is already foreground" early return stamped nothing —
# and a press from a tablet or a second PC ALWAYS lands there, because such a press never moves
# the rig's foreground. The board watches `rfAt` for a change, it never changed, and the cockpit
# detection could not fire from the exact case it was built for. Unit tests: all green.
#
# The rule this encodes: a function whose OUTPUT IS A REPORT must report on every return path.
# A silent success is indistinguishable from a function that never ran.
def rf_module(now_focused, hwnd=0x1234):
    m = load()
    m._refocus_to_elite = m._orig_refocus_to_elite   # put the REAL function back — see load()
    m.os.name = "nt"
    m._set_status = lambda *a, **k: None
    m._elite_hwnd = lambda: hwnd
    m._rf_now = lambda h: now_focused
    m._rf["at"] = 0.0
    m._rf["last"] = ""
    return m

m = rf_module(now_focused=True)
r = m._refocus_to_elite("board:button")
ok("already-foreground path returns True AND stamps an outcome",
   r and m._rf["at"] > 0 and m._rf["last"] == "already",
   "at=%s last=%r" % (m._rf["at"], m._rf["last"]))

# It must be reported as a SUCCESS, not as "failed" — the board discards failures as
# uninformative, so mislabelling this would silently reproduce the original bug.
ok("CONTROL the already-foreground rung is not labelled 'failed'",
   m._rf["last"] != "failed", repr(m._rf["last"]))

# Elite not running: genuinely nothing happened, so nothing may be stamped. Stamping here
# would feed the board a phantom refocus it never performed.
m2 = rf_module(now_focused=False, hwnd=0)
r2 = m2._refocus_to_elite("board:button")
ok("CONTROL Elite not running -> False, and NOTHING stamped",
   (not r2) and m2._rf["at"] == 0.0 and m2._rf["last"] == "",
   "at=%s last=%r" % (m2._rf["at"], m2._rf["last"]))


# ── 6. the foreground-lock opt-in is inert unless asked for ──────────────────
m = load()
m._cfg_bool = lambda k, d: False
m._fglock["applied"] = False
called = []
m._fg_lock_set = lambda ms: (called.append(ms), True)[1]
m._fg_lock_get = lambda: 200000
m._fg_lock_apply()
ok("CONTROL lock unlock does nothing when not opted in",
   called == [] and not m._fglock["applied"], str(called))

m._cfg_bool = lambda k, d: True
m._fg_lock_apply()
ok("opt-in sets the timeout to 0 and remembers the original",
   called == [0] and m._fglock["applied"] and m._fglock["orig"] == 200000,
   "%s orig=%s" % (called, m._fglock["orig"]))

m._fg_lock_restore()
ok("restore puts the original value back",
   called == [0, 200000] and not m._fglock["applied"], str(called))

# Already 0 = nothing of ours to undo. Restoring a 0 we never set would be a no-op anyway,
# but claiming we changed something we did not is how a setting gets "restored" to a value
# the pilot never had.
m2 = load()
m2._cfg_bool = lambda k, d: True
c2 = []
m2._fg_lock_set = lambda ms: (c2.append(ms), True)[1]
m2._fg_lock_get = lambda: 0
m2._fg_lock_apply()
ok("CONTROL a machine already at 0ms is not written to", c2 == [], str(c2))

# An unreadable setting must not be guessed at.
m3 = load()
m3._cfg_bool = lambda k, d: True
c3 = []
m3._fg_lock_set = lambda ms: (c3.append(ms), True)[1]
m3._fg_lock_get = lambda: None
m3._fg_lock_apply()
ok("CONTROL an unreadable setting is left alone",
   c3 == [] and not m3._fglock["applied"], str(c3))


# ── report ───────────────────────────────────────────────────────────────────
fails = [r for r in R if not r[1]]
for name, good, detail in R:
    print(("  ok   " if good else "  FAIL ") + name + (("   [" + detail + "]") if detail and not good else ""))
print("\n%d/%d passed" % (len(R) - len(fails), len(R)))
sys.exit(1 if fails else 0)
