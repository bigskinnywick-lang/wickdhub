"""Proof for the COVAS sidecar. Run: python3 tests/covas_sidecar_test.py

load.py is an EDMC plugin and imports the host at module level, so we lift
_covas_send out of the source and execute THAT — the shipping definition, read
from disk, not a copy. (Same reason as tests/navpull-intent.test.mjs: a control
that cannot see the code it guards is decoration.)

What is being defended:
  1. the message is ATOMIC — a reader never sees a half-written file
  2. two nav pushes in a row do not overwrite each other
  3. a failure to write can NEVER propagate (the clipboard must survive it)
  4. `recorded` carries presence, so "" is never mistaken for "no station"
"""
import json
import os
import re
import sys
import tempfile

SRC = os.path.join(os.path.dirname(__file__), "..", "plugin-src", "BladesRegistrar", "load.py")
src = open(SRC, encoding="utf-8").read()


def lift(name):
    """Pull one top-level def out of load.py by indentation."""
    m = re.search(r"^def %s\(.*?(?=^\S)" % re.escape(name), src, re.M | re.S)
    assert m, name + " not found in load.py"
    return m.group(0)


passed = failed = 0


def t(name, fn):
    global passed, failed
    try:
        fn()
        print("  ok   " + name)
        passed += 1
    except Exception as e:                                    # noqa: BLE001
        print("  FAIL %s\n         %s" % (name, e))
        failed += 1


TMP = tempfile.mkdtemp()
# ⚠ Lift the COLLABORATOR too. _covas_send calls _covas_prune, and lifting only the
# one function left the call unresolvable — which the bare `except` inside _covas_send
# then swallowed into a quiet `return False`. The tests failed loudly here, but note the
# shape: a harness that loads half a unit tests a version of it that never runs.
KEEP = int(re.search(r"^COVAS_INBOX_KEEP = (\d+)", src, re.M).group(1))
ns = {"os": os, "json": json, "COVAS_INBOX": os.path.join(TMP, "inbox"),
      "COVAS_INBOX_KEEP": KEEP}          # read from the source, not hardcoded here
exec(lift("_covas_prune"), ns)                                # noqa: S102
exec(lift("_covas_send"), ns)                                 # noqa: S102
send = ns["_covas_send"]

MSG = {"v": 1, "type": "nav", "ts": 1755500000000, "system": "Nyx",
       "intent": {"commodity": "titanium", "station": "Zoline's Inheritance"},
       "recorded": ["system", "commodity", "station"], "clipboard": True}

def _assert(cond, msg):
    if not cond:
        raise AssertionError(msg)
    return True


def _read(name):
    with open(os.path.join(ns["COVAS_INBOX"], name), encoding="utf-8") as fh:
        return json.load(fh)


def _read_one():
    f = sorted(os.listdir(ns["COVAS_INBOX"]))[0]
    return _read(f)


def _send_into_a_file():
    """Point the inbox at a regular FILE: makedirs then fails, like a full disk or a
    permission change would. The contract is that this is survivable, not that it
    cannot happen."""
    blocked = os.path.join(TMP, "not-a-dir")
    open(blocked, "w").close()
    saved = ns["COVAS_INBOX"]
    ns["COVAS_INBOX"] = blocked
    try:
        return send(MSG)
    finally:
        ns["COVAS_INBOX"] = saved


print("\nDELIVERY")
t("a message is written and reads back intact", lambda: (
    _assert(send(MSG) is True, "send reported failure"),
    _assert(_read_one()["system"] == "Nyx", "system did not survive"),
))
t("the inbox is created if missing", lambda: _assert(
    os.path.isdir(ns["COVAS_INBOX"]), "inbox directory not created"))
t("no .tmp file is left behind", lambda: _assert(
    not [f for f in os.listdir(ns["COVAS_INBOX"]) if f.endswith(".tmp")],
    "a .tmp survived — a reader could catch a half-written message"))
# ⚠ THE TEST ABOVE DOES NOT PROVE ATOMICITY, and it would be easy to believe it does.
# Writing straight to the final path leaves no .tmp either, so it passes just as
# happily on the unsafe version. Proving the real property needs a reader racing a
# writer; asserting the MECHANISM is the honest substitute, so say which one this is.
t("★ the write goes through a tmp + os.replace, not straight to the final path",
  lambda: _assert("os.replace(tmp, final)" in lift("_covas_send"),
                  "atomic rename gone — a COVAS poll can now catch a partial message"))
t("unicode in a station name survives the round trip", lambda: (
    send(dict(MSG, ts=2, intent={"station": u"Zoline’s Inheritance"})),
    _assert(u"’" in _read("nav-2.json")["intent"]["station"], "unicode mangled"),
))

print("\nMAILBOX — two pushes must not collide")
t("★ a second push does not overwrite the first", lambda: (
    send(dict(MSG, ts=1001, system="Sol")),
    send(dict(MSG, ts=1002, system="Nyx")),
    _assert(_read("nav-1001.json")["system"] == "Sol", "first message was clobbered"),
    _assert(_read("nav-1002.json")["system"] == "Nyx", "second message missing"),
))

print("\n★★ THE CLIPBOARD MUST SURVIVE A BROKEN INBOX")
t("★★ an unwritable inbox returns False and does NOT raise", lambda: _assert(
    _send_into_a_file() is False,
    "a failing sidecar raised — that would take the clipboard write down with it"))

print("\nRETENTION — the reader does not exist yet, so the producer caps its own lane")
t("★ the inbox stops growing at the cap", lambda: (
    [send(dict(MSG, ts=10000 + i)) for i in range(70)],
    _assert(len([f for f in os.listdir(ns["COVAS_INBOX"]) if f.endswith(".json")]) <= KEEP,
            "inbox grew past the cap — a mailbox nobody drains grows forever"),
))
t("★ pruning drops the OLDEST and keeps the newest", lambda: (
    _assert(os.path.exists(os.path.join(ns["COVAS_INBOX"], "nav-10069.json")),
            "the newest message was pruned"),
    _assert(not os.path.exists(os.path.join(ns["COVAS_INBOX"], "nav-10000.json")),
            "the oldest message survived the cap"),
))

print("\nCONTRACT")
t("★ an unrecorded station is absent from BOTH intent and recorded", lambda: (
    send({"v": 1, "type": "nav", "ts": 7, "system": "Nyx",
          "intent": {"commodity": "steel"}, "recorded": ["system", "commodity"],
          "clipboard": True}),
    _assert("station" not in _read("nav-7.json")["intent"], "empty station emitted as a value"),
    _assert("station" not in _read("nav-7.json")["recorded"], "station claimed but not held"),
))
t("clipboard:false is carried, so COVAS knows not to Ctrl+V", lambda: (
    send(dict(MSG, ts=8, clipboard=False)),
    _assert(_read("nav-8.json")["clipboard"] is False, "clipboard state lost"),
))
t("the type is in the filename, so a consumer can route without parsing", lambda: _assert(
    os.path.exists(os.path.join(ns["COVAS_INBOX"], "nav-8.json")), "unexpected filename"))


print("\n%d passed, %d failed\n" % (passed, failed))
sys.exit(1 if failed else 0)
