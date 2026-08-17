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
board = {"approved": False, "pair_calls": [], "seen_auth": [], "code": "PAIR42", "hashes": {}}


def fake_http_json(url, payload, timeout=20):
    board["pair_calls"].append((url, payload))
    if url.endswith("/pair"):
        # the board remembers which commander this hash claimed to be
        board["hashes"][payload["hash"]] = payload["cmdr"]
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
    """A board that answers about the RIGHT commander for the hash it was asked
    about. The first version of this stub answered "BIGSKINNY" to every query —
    and the plugin correctly refused to accept an approval for a commander it had
    not asked to be, which is how the stub got found. Leaving the note because it
    is the more useful half of the story: the guard works."""
    url = req.full_url if hasattr(req, "full_url") else str(req)
    board["seen_auth"].append((url, dict(getattr(req, "headers", {}) or {})))
    if "/ingest/pair" in url:
        h = url.split("hash=")[-1]
        who = board["hashes"].get(h, "")
        return FakeResp({"ok": True, "approved": bool(board["approved"] and who), "cmdr": who})
    return FakeResp({"ok": True})


tmp = tempfile.mkdtemp()
L._state["dir"] = tmp
L._http_json = fake_http_json
L.urllib.request.urlopen = fake_urlopen
L._set_status = lambda t: None

CM = "BIGSKINNY"
DR = "DR HANS REINHARDT"

print("\nFIRST RUN — a brand-new install has no credential")
L._dev_load()
L._nav["cmdr"] = CM
check("a secret is minted for this commander on first use", len(L._dev_cred(CM)["secret"]) >= 20)
check("the secret is persisted to device.json", os.path.exists(os.path.join(tmp, "device.json")))
check("hash matches sha256 of the secret",
      L._dev_hash(CM) == hashlib.sha256(L._dev_cred(CM)["secret"].encode()).hexdigest())
check("NEGATIVE: not usable for auth until approved", L._dev_ready(CM) is False)
check("NEGATIVE: no Authorization header is sent while unapproved",
      "Authorization" not in L._dev_headers(cmdr=CM),
      "sending an unapproved token gets refused WITHOUT falling back — instant lockout")
check("the shared key is still used while unpaired", L._dev_key_param(CM).startswith("key="))
check("outgoing payloads still carry the shared key while unpaired",
      "key" in L._dev_body({"cmdr": CM}))

print("\nPAIRING — ask, and show the pilot a code")
L._dev_request_pairing(CM)
check("a pairing request was POSTed", any(u.endswith("/pair") for u, _ in board["pair_calls"]))
sent = board["pair_calls"][0][1]
check("NEGATIVE: the SECRET is never sent when pairing — only its hash",
      L._dev_cred(CM)["secret"] not in json.dumps(sent),
      "the raw secret must never cross the wire at pairing time")
check("the hash IS sent", sent.get("hash") == L._dev_hash(CM))
check("a code is shown to the pilot", L._dev_pair_state(CM)["code"] == "PAIR42")
check("NEGATIVE: still not authenticating with the token", L._dev_ready(CM) is False)

print("\nAPPROVAL — the pilot clicks approve on the board")
L._dev_pair_state(CM)["last_poll"] = 0.0
L._dev_check_approval(CM)
check("NEGATIVE: unapproved poll leaves it unpaired", L._dev_ready(CM) is False)

board["approved"] = True
L._dev_pair_state(CM)["last_poll"] = 0.0
L._dev_check_approval(CM)
check("approval flips this commander to paired", L._dev_ready(CM) is True)
check("the pairing code is cleared once approved", L._dev_pair_state(CM)["code"] == "")

print("\nAFTER PAIRING — the shared key is no longer used at all")
check("Authorization header now present", L._dev_headers(cmdr=CM).get("Authorization", "").startswith("Bearer "))
check("navpull switches to the token", L._dev_key_param(CM).startswith("tok="))
check("NEGATIVE: the shared key is NOT sent in the query string",
      "key=" + L.INGEST_KEY not in L._dev_key_param(CM))
check("NEGATIVE: the shared key is NOT included in payloads any more",
      "key" not in L._dev_body({"cmdr": CM}),
      "a paired plugin must be unaffected when the shared key is retired")

print("\n★ TWO COMMANDERS, ONE PC — the doctor flies from the same rig")
check("NEGATIVE: the second commander is NOT authenticated by the first's token",
      L._dev_ready(DR) is False,
      "a token bound to one commander must never speak for another")
check("NEGATIVE: no Bearer header for the unpaired second commander",
      "Authorization" not in L._dev_headers(cmdr=DR))
check("the second commander falls back to the shared key, not to a 403 loop",
      L._dev_key_param(DR).startswith("key="))
check("...and the FIRST commander is untouched by that", L._dev_ready(CM) is True)
L._dev_request_pairing(DR)
check("the second commander gets their own pairing code", L._dev_pair_state(DR)["code"] == "PAIR42")
check("NEGATIVE: the two secrets are different",
      L._dev_cred(CM)["secret"] != L._dev_cred(DR)["secret"])
board["approved"] = True
L._dev_pair_state(DR)["last_poll"] = 0.0
L._dev_check_approval(DR)
check("both commanders can be paired on one PC at once",
      L._dev_ready(CM) is True and L._dev_ready(DR) is True,
      "the first cut had ONE slot — pairing the doctor would have evicted BIGSKINNY")

print("\n★ A LYING BOARD — approval for the wrong commander must be refused")
_saved = dict(board["hashes"])
board["hashes"][L._dev_hash(DR)] = CM          # board claims DR's hash was approved as BIGSKINNY
L._dev["creds"].pop(L._dev_key(DR), None)      # force DR back to unpaired
L._dev_request_pairing(DR)
board["hashes"][L._dev_hash(DR)] = CM
L._dev_pair_state(DR)["last_poll"] = 0.0
L._dev_check_approval(DR)
check("NEGATIVE: an approval naming a DIFFERENT commander is discarded",
      L._dev_ready(DR) is False,
      "otherwise a compromised board could make this PC speak as anyone")
check("...and the correctly-paired commander is unaffected", L._dev_ready(CM) is True)
board["hashes"] = _saved
# re-pair DR properly for the persistence checks below
L._dev_request_pairing(DR)
L._dev_pair_state(DR)["last_poll"] = 0.0
L._dev_check_approval(DR)

print("\nPERSISTENCE — a restart must not re-pair")
L._dev.update({"creds": {}, "pair": {}, "loaded": False})
L._dev_load()
check("paired state survives an EDMC restart", L._dev_ready(CM) is True)
check("...for BOTH commanders", L._dev_ready(DR) is True)

print("\nRECOVERY — revoked, shared key retired, or a 403 from the wrong commander")
before = L._dev_cred(CM)["secret"]
L._dev_on_auth_fail(CM)
check("an auth failure drops that commander back to unpaired", L._dev_ready(CM) is False)
check("it re-requests pairing automatically", L._dev_pair_state(CM)["code"] == "PAIR42",
      "a dormant pilot must come back to a code, not a dead plugin")
check("the same local secret is reused (no churn)", L._dev_cred(CM)["secret"] == before)
check("NEGATIVE: recovering one commander does NOT unpair the other",
      L._dev_ready(DR) is True,
      "one pilot's revoke must not knock their rig-mate offline")

print("\nMIGRATION — a PC already paired on b3.33 must not have to re-pair")
import shutil
tmp2 = tempfile.mkdtemp()
with open(os.path.join(tmp2, "device.json"), "w") as f:
    json.dump({"secret": "legacy-single-secret-value-aaaa", "approved": True, "cmdr": "BIGSKINNY"}, f)
L._state["dir"] = tmp2
L._dev.update({"creds": {}, "pair": {}, "loaded": False})
L._dev_load()
check("the old single-secret file is carried across", L._dev_ready(CM) is True)
check("the migrated secret is preserved exactly",
      L._dev_cred(CM)["secret"] == "legacy-single-secret-value-aaaa")
check("and it is rewritten in the new shape",
      "creds" in json.load(open(os.path.join(tmp2, "device.json"))))

# ── self-update checksum: the guard on arbitrary code execution ──────────────
print("\n★ SELF-UPDATE — the checksum must be REQUIRED, not merely honoured")
_upd = {"status": []}
L._set_status = lambda t: _upd["status"].append(t)
_fake_zip = b"PK\x03\x04" + b"x" * 800


class _R:
    def __init__(self, b): self._b = b
    def read(self, n=None): return self._b
    def __enter__(self): return self
    def __exit__(self, *a): return False


L.urllib.request.urlopen = lambda req, timeout=60: _R(_fake_zip)

_upd["status"] = []
L._do_update({"version": "b9.9", "url": L.UPDATE_HOST + "blades/x.zip", "sha256": ""})
check("NEGATIVE: an update with NO checksum is refused outright",
      any("no checksum" in x for x in _upd["status"]),
      "a missing checksum used to skip verification and install the payload anyway")

_upd["status"] = []
L._do_update({"version": "b9.9", "url": L.UPDATE_HOST + "blades/x.zip", "sha256": "0" * 64})
check("NEGATIVE: a WRONG checksum is refused",
      any("mismatch" in x for x in _upd["status"]))

_upd["status"] = []
L._do_update({"version": "b9.9", "url": "https://evil.example/x.zip", "sha256": "a" * 64})
check("NEGATIVE: an off-host update URL is refused before anything is downloaded",
      any("bad url" in x for x in _upd["status"]))

print("\n%d passed, %d failed\n" % (PASS, FAIL))
raise SystemExit(1 if FAIL else 0)
