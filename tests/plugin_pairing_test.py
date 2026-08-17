"""End-to-end test of the plugin's device-pairing state machine.

Run: python3 tests/plugin_pairing_test.py

─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
The pairing logic decides, on every single request, whether to present a token
or the shared key. Get that ordering wrong and the plugin either (a) sends an
unapproved token, which the board refuses without falling back, locking the
pilot out, or (b) keeps sending the shared key forever, so the migration never
actually happens and we'd never know.

Neither failure is visible by reading the code — both look fine. So this drives
the real functions from load.py against a fake board and asserts the sequence.

We deliberately assert the NEGATIVE at each step: what must NOT be sent yet.
"""
import hashlib
import importlib.util
import json
import os
import sys
import tempfile
import types

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LOAD_PY = os.path.join(ROOT, "plugin-src", "BladesRegistrar", "load.py")

# load.py imports EDMC modules that don't exist outside EDMC. Stub the ones it
# reaches for at import time so we can exercise the pure logic.
for name, attrs in {
    "myNotebook": {},
    "config": {"config": types.SimpleNamespace(
        get_str=lambda *a, **k: "", get_bool=lambda *a, **k: False,
        get_int=lambda *a, **k: 0, set=lambda *a, **k: None)},
    "monitor": {"monitor": types.SimpleNamespace(cmdr="BIGSKINNY")},
}.items():
    m = types.ModuleType(name)
    for k, v in attrs.items():
        setattr(m, k, v)
    sys.modules.setdefault(name, m)

spec = importlib.util.spec_from_file_location("blades_load", LOAD_PY)
L = importlib.util.module_from_spec(spec)
try:
    spec.loader.exec_module(L)
except Exception as e:  # pragma: no cover
    print("could not import load.py:", e)
    raise SystemExit(1)

PASS = FAIL = 0


def check(name, cond, detail=""):
    global PASS, FAIL
    if cond:
        print("  ok   " + name)
        PASS += 1
    else:
        print("  FAIL " + name + ("\n         " + detail if detail else ""))
        FAIL += 1


# ── fake board ───────────────────────────────────────────────────────────────
board = {"approved": False, "pair_calls": [], "seen_auth": [], "code": "PAIR42"}


def fake_http_json(url, payload, timeout=20):
    board["pair_calls"].append((url, payload))
    if url.endswith("/pair"):
        return {"ok": True, "code": board["code"], "expiresInS": 600}
    return {"ok": True}


class FakeResp:
    def __init__(self, obj):
        self._b = json.dumps(obj).encode()

    def read(self):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def fake_urlopen(req, timeout=8):
    url = req.full_url if hasattr(req, "full_url") else str(req)
    board["seen_auth"].append((url, dict(getattr(req, "headers", {}) or {})))
    if "/ingest/pair" in url:
        return FakeResp({"ok": True, "approved": board["approved"], "cmdr": "BIGSKINNY"})
    return FakeResp({"ok": True})


tmp = tempfile.mkdtemp()
L._state["dir"] = tmp
L._http_json = fake_http_json
L.urllib.request.urlopen = fake_urlopen
L._set_status = lambda t: None

print("\nFIRST RUN — a brand-new install has no credential")
L._dev_load()
check("a secret is minted locally on first load", len(L._dev["secret"]) >= 20)
check("the secret is persisted to device.json", os.path.exists(os.path.join(tmp, "device.json")))
check("hash matches sha256 of the secret",
      L._dev["hash"] == hashlib.sha256(L._dev["secret"].encode()).hexdigest())
check("NEGATIVE: not usable for auth until approved", L._dev_ready() is False)
check("NEGATIVE: no Authorization header is sent while unapproved",
      "Authorization" not in L._dev_headers(),
      "sending an unapproved token gets refused WITHOUT falling back — instant lockout")
check("the shared key is still used while unpaired", L._dev_key_param().startswith("key="))
check("outgoing payloads still carry the shared key while unpaired",
      "key" in L._dev_body({"cmdr": "BIGSKINNY"}))

print("\nPAIRING — ask, and show the pilot a code")
L._dev_request_pairing("BIGSKINNY")
check("a pairing request was POSTed", any(u.endswith("/pair") for u, _ in board["pair_calls"]))
sent = board["pair_calls"][0][1]
check("NEGATIVE: the SECRET is never sent when pairing — only its hash",
      L._dev["secret"] not in json.dumps(sent),
      "the raw secret must never cross the wire at pairing time")
check("the hash IS sent", sent.get("hash") == L._dev["hash"])
check("a code is shown to the pilot", L._dev["code"] == "PAIR42")
check("NEGATIVE: still not authenticating with the token", L._dev_ready() is False)

print("\nAPPROVAL — the pilot clicks approve on the board")
L._dev["last_poll"] = 0.0
L._dev_check_approval()
check("NEGATIVE: unapproved poll leaves it unpaired", L._dev_ready() is False)

board["approved"] = True
L._dev["last_poll"] = 0.0
L._dev_check_approval()
check("approval flips the device to paired", L._dev_ready() is True)
check("the approved commander is recorded", L._dev["cmdr"] == "BIGSKINNY")
check("the pairing code is cleared once approved", L._dev["code"] == "")

print("\nAFTER PAIRING — the shared key is no longer used at all")
check("Authorization header now present", L._dev_headers().get("Authorization", "").startswith("Bearer "))
check("navpull switches to the token", L._dev_key_param().startswith("tok="))
check("NEGATIVE: the shared key is NOT sent in the query string",
      "key=" + L.INGEST_KEY not in L._dev_key_param())
check("NEGATIVE: the shared key is NOT included in payloads any more",
      "key" not in L._dev_body({"cmdr": "BIGSKINNY"}),
      "a paired plugin must be unaffected when the shared key is retired")

print("\nPERSISTENCE — a restart must not re-pair")
L._dev.update({"secret": "", "hash": "", "approved": False, "cmdr": "", "code": ""})
L._dev_load()
check("paired state survives an EDMC restart", L._dev_ready() is True)

print("\nRECOVERY — revoked, or the shared key retired while away")
before = L._dev["secret"]
L._dev_on_auth_fail("BIGSKINNY")
check("a 401 drops the device back to unpaired", L._dev_ready() is False)
check("it re-requests pairing automatically", L._dev["code"] == "PAIR42",
      "a dormant pilot must come back to a code, not a dead plugin")
check("the same local secret is reused (no churn)", L._dev["secret"] == before)

print("\n%d passed, %d failed\n" % (PASS, FAIL))
raise SystemExit(1 if FAIL else 0)
