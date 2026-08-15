"""
Onyx Blades — Build Registrar (EDMC plugin)

When you dock at a colonisation construction ship, Elite writes a
ColonisationConstructionDepot journal event (MarketID). This plugin pairs that
with the current SystemAddress and posts them to the Onyx Blades board's ingest
endpoint, which resolves the RavenColonial buildId and adds it to the squad's
build list automatically.

AUTO-CREATE (optional, off by default): if no build exists in RavenColonial for
the construction site after a short grace period (giving the architect / SrvSurvey
a chance to create it first), the board can create one for you and register it.
Because RavenColonial is a shared community service, this is safeguarded:
  * off unless you enable it in EDMC settings,
  * only fires after the grace period with the site still unregistered,
  * the architect is auto-detected: first from your own claims, then from
    active Raven siblings in the same system, then from completed siblings
    on the board — otherwise your squad name is used (edit it in Raven later).

CLAIMS LEDGER (architect attribution, added 2026-07-21): the game never tells a
visitor who a system's architect is — but ColonisationSystemClaim only ever
appears in the ARCHITECT's own journal (it fires when YOU pay for the claim).
So this plugin reports claims to the squad's claims ledger:
  * live — whenever a claim (or claim release) event fires while EDMC runs,
  * backfill — a one-time scan of your local journal history on first launch,
    reporting every system you ever claimed on this PC (marker file
    claims_backfill.json in the plugin folder; delete it to re-run the scan).
The board's ingest endpoint then attributes builds claims-first, so auto-created
Raven builds carry the real architect instead of the squad fallback.

Install: drop this "BladesRegistrar" folder into your EDMC plugins folder
  Windows:  %LOCALAPPDATA%\\EDMarketConnector\\plugins
  macOS:    ~/Library/Application Support/EDMarketConnector/plugins
  Linux:    ~/.local/share/EDMarketConnector/plugins
then fully restart EDMC. Runs alongside the RavenColonial plugin.
"""
import calendar
import json
import os
import threading
import time
import urllib.request
import urllib.error
import hashlib
import io
import re
import zipfile

PLUGIN_NAME = "Blades Registrar"
PLUGIN_VERSION = "3.0"  # 3.0: PIRATE ALARM. Hostile NPC hails now raise a klaxon and flash the board BEFORE you are interdicted - the pirate talks first, so you get the warning while your hands are still on the stick. Verified against a real hail in flight. A refocus hotkey hands the cockpit back if the board steals your focus. MY DASHBOARD adds live telemetry, readiness and a shared alerts lane. The colonization board infers station type, class and tier from your journals. The plugin now self-updates, checksum-verified. Everything that only existed to prove the shakedown worked is gone - nothing that FAILS was silenced.
# b3.26: THE PIRATE ALARM COULD NOT NAME THE KEY IT PROMISED. When the alarm failed to grab the stick back for you it told you which key would - but the 90-character cap was applied AFTER that hint was added, so a talkative pirate pushed the key name off the end and you read '... - press ' with nothing after it. Whether the alarm was actionable depended on how much the pirate had to say: replayed over 654 journals of real NPC chatter, only 36 of 159 hails delivered the whole remedy, 48 named a fragment of the key and 75 lost the promise entirely. The key name is now reserved FIRST and the pirate's line gets what is left, so the remedy always arrives whole - and a hint that will not fit whole is dropped rather than shown half, because a half-named key sends you reaching for one that isn't there. The 90-char cap does not move and the longest alert is still exactly 90, so the heartbeat does not grow by a byte. Also: the hint no longer appears when Elite is not running at all, where the key you were being told to press was exactly as dead as the automation had just been. Survived eleven builds unseen because b3.15 made the refocus reliable, so the path that carried the bug almost never ran.
# b3.25: THE COCKPIT DETECTION COULD NEVER FIRE. _refocus_to_elite stamped _rf["at"] on the success rung and the failure path but NOT on the "Elite is already foreground" early return - and a press from a tablet or a second PC never moves the rig's foreground, so it ALWAYS landed there. rfAt never changed, the board waited out its 12s window, and no evidence was ever recorded. Now stamped as rung "already", which is the most informative outcome available: plugin says Elite holds focus + the asking browser never blurred = that browser is not this machine. Found by Adam pressing the button repeatedly on a Mac and a tablet and watching nothing happen - the unit tests all passed because they drove _rf_activate directly and never exercised the early return.

# --- config -----------------------------------------------------------------
INGEST_URL = "https://wickdhub.com/ingest/build"
CLAIM_URL = "https://wickdhub.com/ingest/claim"
CARRIER_URL = "https://wickdhub.com/ingest/carrier"
LOADOUT_URL = "https://wickdhub.com/ingest/loadout"
NAVPULL_URL = "https://wickdhub.com/ingest/navpull"
TEL_REFRESH_S = 15  # resend an unchanged live-telemetry snapshot at least this often so the dashboard's liveness ts stays fresh (must stay well under the page's 30s STALE_MS)
STATIONTYPE_URL = "https://wickdhub.com/ingest/station-type"
INGEST_KEY = "6bb6a945625356d9054ea5ec25e65828b1e6061f"
RAVEN_BASE = "https://ravencolonial100-awcbdvabgze4c5cq.canadacentral-01.azurewebsites.net"

# Defaults; overridable in EDMC settings (File > Settings > Blades Registrar).
DEFAULT_AUTOCREATE = False
DEFAULT_ARCHITECT = "Onyx Blades"
DEFAULT_GRACE_MIN = 5
# honk-on-arrival (BladeRelay): opt-in; presses YOUR fire key, read live from binds.
DEFAULT_HONK = False
DEFAULT_HONK_FIRE = "PrimaryFire"
# pirate alarm (BladeRelay): opt-in; watches for someone scanning YOUR ship.
DEFAULT_PIRATE = False
PIRATE_BLARE = True   # also sound a klaxon on THIS PC (Windows only); the board sounds its own
PIRATE_COOLDOWN_S = 12.0  # never blare more than once per this window — a scan can repeat fast
# ----------------------------------------------------------------------------

BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36")

# EDMC config (optional — guarded so the plugin still loads without it).
try:
    from config import config as _cfg
except Exception:
    _cfg = None

_state = {
    "dir": "", "sa": None, "system": None, "body": None, "bodynum": None,
    "seen": set(), "pending": {}, "status": None, "commodities": {},
    "claims": {},  # {systemAddress: cmdr} — local architect cache from claims
}


def _cfg_bool(key, default):
    if _cfg is None:
        return default
    try:
        return bool(_cfg.get_bool(key, default=default))
    except Exception:
        try:
            v = _cfg.getint(key)
            return default if v is None else bool(v)
        except Exception:
            return default


def _cfg_str(key, default):
    if _cfg is None:
        return default
    try:
        v = _cfg.get_str(key, default=default)
    except Exception:
        try:
            v = _cfg.get(key)
        except Exception:
            v = None
    return v if v else default


def _cfg_int(key, default):
    if _cfg is None:
        return default
    try:
        v = _cfg.get_int(key, default=default)
    except Exception:
        try:
            v = _cfg.getint(key)
        except Exception:
            v = None
    return default if v is None else int(v)


# server-driven per-pilot settings (set on the site, delivered on the nav poll).
# Cached to disk so they persist offline / across restarts. A server value wins
# when present; otherwise we fall back to the EDMC checkbox / default.
# ⚠ Every key in _SRV_KEYS must also exist here. `refocus` was missing until b3.21, so on a
# fresh install (before the first _load_srv/_apply_srv) `_srv["refocus"]` raised KeyError and
# `_refocus_on()` swallowed it and answered False — the feature reading as "off" for reasons
# nothing reported. Same silent-off shape that cost a day on 2026-08-10.
_srv = {"autocreate": None, "honk": None, "galaxymap": None, "fuel": None, "pirate": None,
        "refocus": None, "refocusact": None}

# Every server-driven setting key, in one place — the load / apply / persist paths all
# read this tuple, so adding an assist is a one-line change here instead of four.
_SRV_KEYS = ("autocreate", "honk", "galaxymap", "fuel", "pirate", "refocus", "refocusact")


def _srv_path():
    return os.path.join(_state["dir"], "server_settings.json")


def _load_srv():
    try:
        with open(_srv_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict):
            for _k in _SRV_KEYS:
                _srv[_k] = d.get(_k)
    except Exception:
        pass


def _apply_srv(settings):
    """Called each nav poll with this pilot's {autocreate, honk} from the board."""
    if not isinstance(settings, dict):
        return
    changed = False
    _rf_before = _refocus_on()
    for k in _SRV_KEYS:
        if k in settings and settings[k] is not None:
            v = bool(settings[k])
            if _srv.get(k) != v:
                changed = True
            _srv[k] = v
    if changed:
        try:
            with open(_srv_path(), "w", encoding="utf-8") as f:
                json.dump({kk: _srv[kk] for kk in _SRV_KEYS}, f)
        except Exception:
            pass
        if _srv.get("honk"):
            try:
                _hk_resolve()
            except Exception:
                pass
        if _srv.get("galaxymap"):
            try:
                _gm_resolve()
            except Exception:
                pass
    try:
        if _refocus_on() != _rf_before:
            _rf_sync()
    except Exception:
        pass
    # A settings change observed on a poll IS an activation: the pilot was on the board a
    # moment ago flipping a switch. No timestamp needed — `changed` can only be true on the
    # first poll AFTER the write, so its age is bounded by the poll interval by construction.
    # The one exception is a plugin that was offline while settings moved; `_rfa["primed"]`
    # covers that (see _rf_activate).
    if changed:
        try:
            _rf_activate("toggle")
        except Exception:
            pass                                   # refocus must never break settings


def _autocreate():
    if _srv.get("autocreate") is not None:
        return bool(_srv["autocreate"])
    return _cfg_bool("blades_autocreate", DEFAULT_AUTOCREATE)


def _architect():
    return _cfg_str("blades_architect", DEFAULT_ARCHITECT)


def _grace_seconds():
    return max(0, _cfg_int("blades_grace_min", DEFAULT_GRACE_MIN)) * 60


def _honk_on():
    if _srv.get("honk") is not None:
        return bool(_srv["honk"])
    return _cfg_bool("blades_honk", DEFAULT_HONK)


def _honk_fire():
    return _cfg_str("blades_honk_fire", DEFAULT_HONK_FIRE)


def _galaxymap_on():
    if _srv.get("galaxymap") is not None:
        return bool(_srv["galaxymap"])
    return _cfg_bool("blades_galaxymap", False)


def _fuel_on():
    if _srv.get("fuel") is not None:
        return bool(_srv["fuel"])
    return _cfg_bool("blades_fuel", False)


def _pirate_on():
    if _srv.get("pirate") is not None:
        return bool(_srv["pirate"])
    return _cfg_bool("blades_pirate", DEFAULT_PIRATE)


# --- seen persistence -------------------------------------------------------
def _seen_path():
    return os.path.join(_state["dir"], "registered.json")


def _load_seen():
    try:
        with open(_seen_path(), "r", encoding="utf-8") as f:
            _state["seen"] = set(json.load(f))
    except Exception:
        _state["seen"] = set()


def _save_seen():
    try:
        with open(_seen_path(), "w", encoding="utf-8") as f:
            json.dump(sorted(_state["seen"]), f)
    except Exception:
        pass


def _set_status(text):
    lbl = _state.get("status")
    if lbl is not None:
        try:
            lbl["text"] = "Blades: " + text
        except Exception:
            pass


# --- claims ledger ----------------------------------------------------------
BACKFILL_MARKER = "claims_backfill.json"


def _iso_ms(ts):
    """Journal ISO timestamp ('2026-07-21T03:00:00Z') -> epoch millis."""
    try:
        return calendar.timegm(time.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")) * 1000
    except Exception:
        return int(time.time() * 1000)


def _http_json(url, payload, timeout=20):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        url, data=data,
        headers={
            "Content-Type": "application/json",
            "User-Agent": BROWSER_UA,  # Cloudflare BIC rejects Python-urllib UAs
            "Accept": "application/json",
        }, method="POST",
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _send_claim(payload, label):
    try:
        body = _http_json(CLAIM_URL, payload)
        if body.get("ok"):
            _set_status(label)
        else:
            _set_status("claim error (" + str(body.get("error", "?")) + ")")
    except urllib.error.HTTPError as he:
        _set_status("claim auth error (bad key)" if he.code == 401 else "claim error " + str(he.code))
    except Exception:
        _set_status("claim post failed (offline?)")


def _send_carrier(payload, label):
    try:
        body = _http_json(CARRIER_URL, payload)
        if body.get("ok"):
            _set_status(label)
        else:
            _set_status("carrier error (" + str(body.get("error", "?")) + ")")
    except urllib.error.HTTPError as he:
        _set_status("carrier auth error (bad key)" if he.code == 401 else "carrier error " + str(he.code))
    except Exception:
        _set_status("carrier post failed (offline?)")


_STATIONMETA_SENT = {}


def _send_station_type(payload, label):
    # Fire-and-forget: report a completed station's real type/economy. Best-effort.
    try:
        body = _http_json(STATIONTYPE_URL, payload)
        if body.get("ok"):
            _set_status(label)
    except Exception:
        pass


# --- ship + cargo hold (loadout) --------------------------------------------
# Reported from the game's Loadout (ship + max cargo) and Cargo (current tonnage)
# events so the boards can show, per member, what everyone flies and can haul.
_LO = {"ship": "", "shipName": "", "cargoCap": None, "cargoUsed": None, "last_post": 0.0, "sig": None}


def _send_loadout(payload, label):
    try:
        body = _http_json(LOADOUT_URL, payload)
        if body.get("ok"):
            _set_status(label)
        else:
            _set_status("loadout error (" + str(body.get("error", "?")) + ")")
    except urllib.error.HTTPError as he:
        _set_status("loadout auth error (bad key)" if he.code == 401 else "loadout error " + str(he.code))
    except Exception:
        _set_status("loadout post failed (offline?)")


def _maybe_send_loadout(cmdr, ts, force=False):
    # Need a ship + a known capacity before it's worth reporting.
    if _LO["cargoCap"] is None or not _LO["ship"]:
        return
    sig = (_LO["ship"], _LO["shipName"], _LO["cargoCap"], _LO["cargoUsed"])
    now = time.time()
    # Debounce Cargo spam: post only on a real change, at most every 6s
    # (a ship swap / new Loadout forces through immediately).
    if not force:
        if sig == _LO["sig"]:
            return
        if (now - _LO["last_post"]) < 6.0:
            return
    _LO["sig"] = sig
    _LO["last_post"] = now
    payload = {
        "key": INGEST_KEY,
        "cmdr": cmdr or "unknown",
        "ship": _LO["ship"],
        "shipName": _LO["shipName"],
        "cargoCap": _LO["cargoCap"],
        "cargoUsed": _LO["cargoUsed"] or 0,
        "ts": ts,
        "via": "live",
    }
    label = "hold logged: " + (_LO["shipName"] or _LO["ship"]) + " " + str(_LO["cargoUsed"] or 0) + "/" + str(_LO["cargoCap"]) + "t"
    threading.Thread(target=_send_loadout, args=(payload, label), daemon=True).start()


# --- nav push -> PC clipboard (from the board) ------------------------------
# The board POSTs a galaxy-map target to /blades/api/navpush keyed to THIS pilot;
# we poll /ingest/navpull for it and drop it on the PC clipboard for a paste into
# the galaxy-map search. Per-pilot: we only ever pull our own CMDR's target.
_nav = {"cmdr": "", "last_ts": 0, "act_ts": 0, "started": False}


def _set_clipboard(text):
    """Set the Windows clipboard (CF_UNICODETEXT) via ctypes. Thread-safe (OS-owned),
    so it is safe to call from the poll thread without touching Tk."""
    try:
        import ctypes
        CF_UNICODETEXT = 13
        GMEM_MOVEABLE = 0x0002
        u = ctypes.windll.user32
        k = ctypes.windll.kernel32
        # 64-bit correctness: handles/pointers must not be truncated to int.
        k.GlobalAlloc.restype = ctypes.c_void_p
        k.GlobalAlloc.argtypes = [ctypes.c_uint, ctypes.c_size_t]
        k.GlobalLock.restype = ctypes.c_void_p
        k.GlobalLock.argtypes = [ctypes.c_void_p]
        k.GlobalUnlock.argtypes = [ctypes.c_void_p]
        u.OpenClipboard.argtypes = [ctypes.c_void_p]
        u.SetClipboardData.restype = ctypes.c_void_p
        u.SetClipboardData.argtypes = [ctypes.c_uint, ctypes.c_void_p]
        if not u.OpenClipboard(None):
            return False
        try:
            u.EmptyClipboard()
            buf = ctypes.create_unicode_buffer(text)   # auto NUL-terminated (UTF-16)
            size = ctypes.sizeof(buf)
            h = k.GlobalAlloc(GMEM_MOVEABLE, size)
            if not h:
                return False
            p = k.GlobalLock(h)
            ctypes.memmove(p, buf, size)
            k.GlobalUnlock(h)
            u.SetClipboardData(CF_UNICODETEXT, h)       # system takes ownership of h
            return True
        finally:
            u.CloseClipboard()
    except Exception:
        return False


def _apply_nav(system):
    """Runs on the Tk MAIN thread (scheduled via .after): set the clipboard the reliable
    way for a Tk app, fall back to the ctypes path, and report the outcome."""
    ok = False
    try:
        lbl = _state.get("status")
        if lbl is not None:
            lbl.clipboard_clear()
            lbl.clipboard_append(system)
            lbl.update_idletasks()
            ok = True
    except Exception:
        ok = False
    if not ok:
        ok = _set_clipboard(system)
    _set_status(("nav -> clipboard: " if ok else "nav rx (clipboard busy): ") + system)
    if _galaxymap_on():
        threading.Thread(target=_gm_paste, daemon=True).start()


# --- self-update (channel-aware; the board decides stable vs beta per pilot) --------
# Each nav poll we send our running version and pull back the release we SHOULD be on
# ("latest"). If it is newer, we download that zip FROM wickdhub.com ONLY, verify its
# SHA-256, atomically swap load.py, and stage it -- then blare "RESTART EDMC" until the
# pilot restarts (at which point the running version matches latest and it clears).
UPDATE_MARKER = "update_pending.json"
UPDATE_HOST = "https://wickdhub.com/"
_upd = {"busy": False, "staged": ""}


def _update_marker_path():
    return os.path.join(_state["dir"], UPDATE_MARKER)


def _read_pending():
    try:
        with open(_update_marker_path(), "r", encoding="utf-8") as f:
            d = json.load(f)
            return d if isinstance(d, dict) else {}
    except Exception:
        return {}


def _write_pending(ver):
    try:
        with open(_update_marker_path(), "w", encoding="utf-8") as f:
            json.dump({"version": ver, "ts": int(time.time())}, f)
    except Exception:
        pass


def _clear_pending():
    try:
        os.remove(_update_marker_path())
    except Exception:
        pass


def _ver_tuple(v):
    return tuple(int(x) for x in re.findall(r"\d+", str(v or "")))


def _ver_newer(a, b):
    return _ver_tuple(a) > _ver_tuple(b)


def _is_beta(v):
    return bool(re.search(r"[A-Za-z]", str(v or "")))


def _maybe_update(latest, channel=""):
    """Called each nav poll with the board's 'latest' release + channel for this pilot."""
    try:
        if not isinstance(latest, dict):
            return
        lv = str(latest.get("version") or "").strip()
        if not lv:
            return
        # The board tells us which build we SHOULD be on for our current channel; converge to
        # exactly that build. A channel SWITCH (retail<->beta, either direction) is always
        # honoured -- so arming/disarming the test track works even when the two builds share a
        # version number. WITHIN a channel we only ever move FORWARD, never auto-downgrade
        # (guards against a bad/stale manifest rolling everyone back).
        running_beta = _is_beta(PLUGIN_VERSION)
        target_beta = (channel == "beta") if channel else _is_beta(lv)
        if lv == PLUGIN_VERSION:
            return
        if running_beta == target_beta and not _ver_newer(lv, PLUGIN_VERSION):
            return
        if _upd["staged"] == lv or _read_pending().get("version") == lv:
            _upd["staged"] = lv
            _set_status("UPDATE READY v%s -> RESTART EDMC" % lv)
            return
        if _upd["busy"]:
            return
        _upd["busy"] = True
        threading.Thread(target=_do_update, args=(dict(latest),), daemon=True).start()
    except Exception:
        pass


def _do_update(latest):
    try:
        lv = str(latest.get("version") or "").strip()
        url = str(latest.get("url") or "")
        want = str(latest.get("sha256") or "").lower().strip()
        if not url.startswith(UPDATE_HOST):
            _set_status("update blocked (bad url)")
            return
        req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA})
        with urllib.request.urlopen(req, timeout=60) as resp:
            data = resp.read(8 * 1024 * 1024 + 1)
        if len(data) > 8 * 1024 * 1024:
            _set_status("update too large -- skipped")
            return
        if want and hashlib.sha256(data).hexdigest().lower() != want:
            _set_status("update checksum mismatch -- skipped")
            return
        zf = zipfile.ZipFile(io.BytesIO(data))
        name = None
        for n in zf.namelist():
            nn = n.replace("\\", "/")
            if nn == "load.py" or nn.endswith("/load.py"):
                name = n
                break
        if not name:
            _set_status("update: load.py not in zip")
            return
        newsrc = zf.read(name)
        if len(newsrc) < 500 or b"PLUGIN_VERSION" not in newsrc:
            _set_status("update: payload looks wrong -- skipped")
            return
        dst = os.path.join(_state["dir"], "load.py")
        tmp = dst + ".new"
        with open(tmp, "wb") as fh:
            fh.write(newsrc)
        os.replace(tmp, dst)
        _write_pending(lv)
        _upd["staged"] = lv
        _set_status("UPDATE READY v%s -> RESTART EDMC" % lv)
    except Exception as e:
        _set_status("update failed (%s)" % type(e).__name__)
    finally:
        _upd["busy"] = False


def _nav_poll_loop():
    while True:
        try:
            cmdr = _nav.get("cmdr")
            if not cmdr:
                # Fall back to EDMC's own commander if no journal event has set it yet.
                try:
                    from monitor import monitor
                    if getattr(monitor, "cmdr", None):
                        cmdr = monitor.cmdr
                        _nav["cmdr"] = cmdr
                except Exception:
                    pass
            if cmdr:
                pend = _read_pending().get("version", "")
                # Per-assist readiness rides the same heartbeat, but only when it CHANGES —
                # binds rarely move, so this stays quiet after the first poll and never
                # rewrites KV every 5s.
                try:
                    _rdy = json.dumps(_assist_readiness(), separators=(",", ":"))
                except Exception:
                    _rdy = ""
                _send_rdy = _rdy if (_rdy and _rdy != _nav.get("ready_sent")) else ""
                # Live telemetry rides the heartbeat. While Elite is live, _assist_telemetry()
                # returns a non-empty snapshot; resend it when it CHANGES *or* at least every
                # TEL_REFRESH_S even if unchanged, so a parked/docked pilot (fuel/cargo/state not
                # moving) keeps a fresh liveness ts and the strip stays LIVE instead of greying
                # after 30s. When Elite isn't live the snapshot is {} -> nothing sent -> greys.
                try:
                    _tel = json.dumps(_assist_telemetry(), separators=(",", ":"))
                except Exception:
                    _tel = ""
                _tel_live = bool(_tel and _tel != "{}")
                _tel_stale = (time.time() - _nav.get("tel_at", 0)) >= TEL_REFRESH_S
                _send_tel = _tel if (_tel_live and (_tel != _nav.get("tel_sent") or _tel_stale)) else ""
                # Alerts ride the same heartbeat, sent only when the ring CHANGES — i.e. only
                # when something actually happened. The board dedups by alert id, so a resend
                # after a failed poll can never double-sound the klaxon.
                try:
                    _al = json.dumps(_alerts_payload(), separators=(",", ":"))
                except Exception:
                    _al = ""
                _send_al = _al if (_al and _al != "[]" and _al != _nav.get("al_sent")) else ""
                url = (NAVPULL_URL + "?key=" + INGEST_KEY + "&cmdr=" + urllib.request.quote(cmdr)
                       + "&v=" + urllib.request.quote(PLUGIN_VERSION)
                       + (("&pending=" + urllib.request.quote(pend)) if pend else "")
                       + (("&ready=" + urllib.request.quote(_send_rdy)) if _send_rdy else "")
                       + (("&tel=" + urllib.request.quote(_send_tel)) if _send_tel else "")
                       + (("&al=" + urllib.request.quote(_send_al)) if _send_al else ""))
                req = urllib.request.Request(url, headers={"User-Agent": BROWSER_UA, "Accept": "application/json"})
                with urllib.request.urlopen(req, timeout=8) as resp:
                    body = json.loads(resp.read().decode("utf-8"))
                if _send_rdy:
                    _nav["ready_sent"] = _rdy   # only after the poll succeeds; a failed send retries next loop
                if _send_tel:
                    _nav["tel_sent"] = _tel
                    _nav["tel_at"] = time.time()
                if _send_al:
                    _nav["al_sent"] = _al
                try:
                    _maybe_update(body.get("latest"), body.get("channel"))
                except Exception:
                    pass
                try:
                    _apply_srv(body.get("settings"))
                except Exception:
                    pass
                sysname = body.get("system")
                ts = body.get("ts", 0) or 0
                if sysname and ts > _nav["last_ts"]:
                    _nav["last_ts"] = ts
                    _set_status("nav rx: " + sysname)  # visible proof the pull worked
                    # ★ Age is computed from TWO SERVER TIMESTAMPS — the worker stamps the
                    # push (`ts`) and reports its own clock (`now`) in the same response — so
                    # the rig's clock never enters the arithmetic. Comparing a Cloudflare ts
                    # against local time would make the freshness gate a clock-skew detector.
                    # No `now` (an older worker) => age unknown => fail closed, no refocus.
                    age_s = None
                    try:
                        _srv_now = float(body.get("now") or 0)
                        if _srv_now > 0 and float(ts) > 0:
                            age_s = max(0.0, (_srv_now - float(ts)) / 1000.0)
                    except (TypeError, ValueError):
                        age_s = None
                    # ★ REFOCUS FIRST, THEN CLIPBOARD+PASTE — deliberate, and it fixes a
                    # second thing: _gm_paste bails when Elite is not foreground, so
                    # auto-plot-to-galaxy-map has been skipping on exactly the NAV sends it
                    # exists to serve (you were still on the board). Landing focus first
                    # gives it the state it needs. Synchronous, so it cannot race the
                    # .after(0) below; the poll thread sleeps 5s afterwards anyway.
                    try:
                        _rf_activate("nav", age_s if age_s is not None else _RF_AGE_UNKNOWN)
                    except Exception:
                        pass
                    lbl = _state.get("status")
                    if lbl is not None:
                        try:
                            lbl.after(0, lambda snm=sysname: _apply_nav(snm))
                        except Exception:
                            _apply_nav(sysname)
                    else:
                        _apply_nav(sysname)
                # b3.22 — the BACK TO GAME button. Its own lane, deduped by ts exactly like
                # nav, so a record still inside its 60s TTL cannot re-fire on every poll.
                try:
                    _act = body.get("act")
                    if isinstance(_act, dict):
                        _ats = float(_act.get("ts") or 0)
                        if _ats > _nav.get("act_ts", 0):
                            _nav["act_ts"] = _ats
                            _aage = None
                            try:
                                _sn = float(body.get("now") or 0)
                                if _sn > 0 and _ats > 0:
                                    _aage = max(0.0, (_sn - _ats) / 1000.0)
                            except (TypeError, ValueError):
                                _aage = None
                            _rf_activate("button:" + str(_act.get("kind") or "button")[:24],
                                         _aage if _aage is not None else _RF_AGE_UNKNOWN,
                                         explicit=True)
                except Exception:
                    pass                          # the button must never take the poll down
                # A poll completed: from here on, a change means the pilot just made it.
                _rfa["primed"] = True
        except Exception:
            pass
        time.sleep(5)


def _start_nav_poll():
    if _nav["started"]:
        return
    _nav["started"] = True
    threading.Thread(target=_nav_poll_loop, daemon=True).start()


def _journal_dir():
    """The game's journal folder: EDMC's setting first, then platform defaults."""
    if _cfg is not None:
        try:
            d = _cfg.get_str("journaldir")
            if d and os.path.isdir(d):
                return d
        except Exception:
            pass
    home = os.path.expanduser("~")
    for d in (
        os.path.join(os.environ.get("USERPROFILE", home), "Saved Games", "Frontier Developments", "Elite Dangerous"),
        os.path.join(home, "Library", "Application Support", "Frontier Developments", "Elite Dangerous"),
        os.path.join(home, ".local", "share", "Frontier Developments", "Elite Dangerous"),
    ):
        if os.path.isdir(d):
            return d
    return None


def _scan_journals(jdir):
    """One pass over journal history (chronological by filename). Returns the
    systems whose FINAL state is 'claimed', each paired with the commander who
    was logged in when the claim fired — that commander IS the architect."""
    claims = {}
    try:
        files = sorted(f for f in os.listdir(jdir) if f.startswith("Journal") and f.endswith(".log"))
    except Exception:
        return []
    for fn in files:
        try:
            with open(os.path.join(jdir, fn), "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except Exception:
            continue
        if "ColonisationSystemClaim" not in text:
            continue
        file_cmdr = None
        for line in text.splitlines():
            # cheap pre-filter: only json-parse lines that can matter
            if '"Commander"' not in line and "ColonisationSystemClaim" not in line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            ev = e.get("event")
            if ev == "Commander":
                file_cmdr = e.get("Name") or file_cmdr
            elif ev == "LoadGame":
                file_cmdr = e.get("Commander") or file_cmdr
            elif ev == "ColonisationSystemClaim":
                sa = e.get("SystemAddress")
                if sa and file_cmdr:
                    claims[sa] = {
                        "systemAddress": sa,
                        "systemName": e.get("StarSystem") or "",
                        "cmdr": file_cmdr,
                        "ts": _iso_ms(e.get("timestamp")),
                        "action": "claim",
                    }
            elif ev == "ColonisationSystemClaimRelease":
                claims.pop(e.get("SystemAddress"), None)
    return list(claims.values())


def _scan_carriers(jdir):
    """One pass over journal history for fleet-carrier ownership. CarrierStats only
    appears in the OWNER's own journal, so the last one per carrier names its owner.
    Returns [{marketId, callsign, name, cmdr, ts}] (newest per market)."""
    carriers = {}
    try:
        files = sorted(f for f in os.listdir(jdir) if f.startswith("Journal") and f.endswith(".log"))
    except Exception:
        return []
    for fn in files:
        try:
            with open(os.path.join(jdir, fn), "r", encoding="utf-8", errors="ignore") as f:
                text = f.read()
        except Exception:
            continue
        if "CarrierStats" not in text:
            continue
        file_cmdr = None
        for line in text.splitlines():
            if '"Commander"' not in line and "CarrierStats" not in line and "LoadGame" not in line:
                continue
            try:
                e = json.loads(line)
            except Exception:
                continue
            ev = e.get("event")
            if ev == "Commander":
                file_cmdr = e.get("Name") or file_cmdr
            elif ev == "LoadGame":
                file_cmdr = e.get("Commander") or file_cmdr
            elif ev == "CarrierStats":
                mid = e.get("CarrierID")
                if mid and file_cmdr:
                    carriers[mid] = {
                        "marketId": mid,
                        "callsign": e.get("Callsign") or "",
                        "name": e.get("Name") or "",
                        "cmdr": file_cmdr,
                        "ts": _iso_ms(e.get("timestamp")),
                    }
    return list(carriers.values())


def _backfill_path():
    return os.path.join(_state["dir"], BACKFILL_MARKER)


def _write_backfill_marker(n):
    try:
        with open(_backfill_path(), "w", encoding="utf-8") as f:
            json.dump({"done": True, "count": n, "ts": int(time.time())}, f)
    except Exception:
        pass


def _run_backfill(delay=10):
    """Journal-history claim scan -> report your final-'claimed' systems to the
    ledger, plus fleet-carrier ownership. READ-AND-REPORT ONLY — it creates nothing.

    b3.24: runs at launch for EVERY pilot, not only those with auto-create on (see the
    call site). Still one-time per marker, and saving the settings tab with auto-create
    on clears the marker to force a re-scan."""
    try:
        if delay:
            time.sleep(delay)  # let EDMC finish booting (status label, journal catch-up)
        if os.path.exists(_backfill_path()):
            return
        jdir = _journal_dir()
        if not jdir:
            _set_status("claims backfill: journal folder not found")
            return
        # Fleet-carrier ownership backfill (independent of claims -- a pilot may own a
        # carrier but have no claims). Best-effort; failure never blocks the claims scan.
        try:
            cfound = _scan_carriers(jdir)
            for i in range(0, len(cfound), 100):
                _http_json(CARRIER_URL, {"key": INGEST_KEY, "via": "backfill",
                                         "carriers": cfound[i:i + 100]}, timeout=30)
        except Exception:
            pass
        found = _scan_journals(jdir)
        # Cache claims locally for architect detection during auto-create.
        for c in found:
            sa = c.get("systemAddress")
            cmdr_name = c.get("cmdr")
            if sa and cmdr_name:
                _state["claims"][sa] = cmdr_name
        if not found:
            _write_backfill_marker(0)
            return
        sent = 0
        try:
            for i in range(0, len(found), 100):
                body = _http_json(CLAIM_URL, {"key": INGEST_KEY, "via": "backfill",
                                              "claims": found[i:i + 100]}, timeout=30)
                if not body.get("ok"):
                    _set_status("claims backfill error (" + str(body.get("error", "?")) + ")")
                    return
                sent += len(found[i:i + 100])
        except urllib.error.HTTPError as he:
            _set_status("claims backfill auth error (bad key)" if he.code == 401
                        else "claims backfill error " + str(he.code))
            return
        except Exception:
            _set_status("claims backfill failed (offline?) — will retry next launch")
            return
        _write_backfill_marker(sent)
        _set_status("claims backfill: %d system(s) reported" % sent)
    except Exception:
        pass


# --- honk-on-arrival (BladeRelay, folded in) --------------------------------
# On a real jump (FSDJump) auto-fire the Discovery Scanner "honk" by holding
# YOUR fire key ~6s. The key is read live from your .binds — nothing hardcoded.
# Opt-in (EDMC settings). Windows only; a no-op on macOS/Linux. Safety gates:
# only when Elite is the foreground window, hardpoints RETRACTED (a mis-fire
# can't shoot), not docked, and never twice for one system. A honk writes an
# FSSDiscoveryScan back to the journal, which we use to verify + de-dupe.
# Verified method (on the rig): keybd_event with the virtual key + re-assert.
import glob as _glob

_HK_HOLD_S = 6.0
_HK_DELAY_S = 3.0
_HK_REASSERT = 0.04
_HK_FLAG_DOCKED = 0x00000001
_HK_FLAG_HARDPOINTS = 0x00000040

_hk = {"key": None, "sc": None, "vk": None, "mods": [], "flags": None,
       "honked": set(), "resolved": False}

# ED key name -> Set-1 scancode (scancode, is_extended)
_HK_SC = {
    "Key_A": (0x1E, 0), "Key_B": (0x30, 0), "Key_C": (0x2E, 0), "Key_D": (0x20, 0), "Key_E": (0x12, 0),
    "Key_F": (0x21, 0), "Key_G": (0x22, 0), "Key_H": (0x23, 0), "Key_I": (0x17, 0), "Key_J": (0x24, 0),
    "Key_K": (0x25, 0), "Key_L": (0x26, 0), "Key_M": (0x32, 0), "Key_N": (0x31, 0), "Key_O": (0x18, 0),
    "Key_P": (0x19, 0), "Key_Q": (0x10, 0), "Key_R": (0x13, 0), "Key_S": (0x1F, 0), "Key_T": (0x14, 0),
    "Key_U": (0x16, 0), "Key_V": (0x2F, 0), "Key_W": (0x11, 0), "Key_X": (0x2D, 0), "Key_Y": (0x15, 0), "Key_Z": (0x2C, 0),
    "Key_1": (0x02, 0), "Key_2": (0x03, 0), "Key_3": (0x04, 0), "Key_4": (0x05, 0), "Key_5": (0x06, 0),
    "Key_6": (0x07, 0), "Key_7": (0x08, 0), "Key_8": (0x09, 0), "Key_9": (0x0A, 0), "Key_0": (0x0B, 0),
    "Key_Minus": (0x0C, 0), "Key_Equals": (0x0D, 0), "Key_Backspace": (0x0E, 0), "Key_Tab": (0x0F, 0),
    "Key_LeftBracket": (0x1A, 0), "Key_RightBracket": (0x1B, 0), "Key_Enter": (0x1C, 0),
    "Key_SemiColon": (0x27, 0), "Key_Apostrophe": (0x28, 0), "Key_Grave": (0x29, 0),
    "Key_BackSlash": (0x2B, 0), "Key_Comma": (0x33, 0), "Key_Period": (0x34, 0), "Key_Slash": (0x35, 0),
    "Key_Space": (0x39, 0), "Key_Escape": (0x01, 0), "Key_CapsLock": (0x3A, 0),
    "Key_LeftShift": (0x2A, 0), "Key_RightShift": (0x36, 0), "Key_LeftControl": (0x1D, 0),
    "Key_RightControl": (0x1D, 1), "Key_LeftAlt": (0x38, 0), "Key_RightAlt": (0x38, 1),
    "Key_F1": (0x3B, 0), "Key_F2": (0x3C, 0), "Key_F3": (0x3D, 0), "Key_F4": (0x3E, 0), "Key_F5": (0x3F, 0),
    "Key_F6": (0x40, 0), "Key_F7": (0x41, 0), "Key_F8": (0x42, 0), "Key_F9": (0x43, 0), "Key_F10": (0x44, 0),
    "Key_F11": (0x57, 0), "Key_F12": (0x58, 0),
    "Key_NumLock": (0x45, 0), "Key_Numpad_7": (0x47, 0), "Key_Numpad_8": (0x48, 0), "Key_Numpad_9": (0x49, 0),
    "Key_Numpad_Subtract": (0x4A, 0), "Key_Numpad_4": (0x4B, 0), "Key_Numpad_5": (0x4C, 0), "Key_Numpad_6": (0x4D, 0),
    "Key_Numpad_Add": (0x4E, 0), "Key_Numpad_1": (0x4F, 0), "Key_Numpad_2": (0x50, 0), "Key_Numpad_3": (0x51, 0),
    "Key_Numpad_0": (0x52, 0), "Key_Numpad_Decimal": (0x53, 0), "Key_Numpad_Multiply": (0x37, 0),
    "Key_Numpad_Divide": (0x35, 1), "Key_Numpad_Enter": (0x1C, 1),
    "Key_Insert": (0x52, 1), "Key_Delete": (0x53, 1), "Key_Home": (0x47, 1), "Key_End": (0x4F, 1),
    "Key_PageUp": (0x49, 1), "Key_PageDown": (0x51, 1),
    "Key_UpArrow": (0x48, 1), "Key_DownArrow": (0x50, 1), "Key_LeftArrow": (0x4B, 1), "Key_RightArrow": (0x4D, 1),
}
# ED key name -> Windows virtual-key code
_HK_VK = {}
for _hki, _hkc in enumerate("ABCDEFGHIJKLMNOPQRSTUVWXYZ"):
    _HK_VK["Key_" + _hkc] = 0x41 + _hki
for _hkd in range(10):
    _HK_VK["Key_%d" % _hkd] = 0x30 + _hkd
for _hkd in range(10):
    _HK_VK["Key_Numpad_%d" % _hkd] = 0x60 + _hkd
for _hki in range(1, 13):
    _HK_VK["Key_F%d" % _hki] = 0x6F + _hki
_HK_VK.update({
    "Key_Numpad_Decimal": 0x6E, "Key_Numpad_Multiply": 0x6A, "Key_Numpad_Add": 0x6B,
    "Key_Numpad_Subtract": 0x6D, "Key_Numpad_Divide": 0x6F, "Key_Numpad_Enter": 0x0D,
    "Key_Space": 0x20, "Key_Enter": 0x0D, "Key_Tab": 0x09, "Key_Escape": 0x1B, "Key_Backspace": 0x08,
    "Key_LeftShift": 0xA0, "Key_RightShift": 0xA1, "Key_LeftControl": 0xA2, "Key_RightControl": 0xA3,
    "Key_LeftAlt": 0xA4, "Key_RightAlt": 0xA5, "Key_CapsLock": 0x14,
    "Key_UpArrow": 0x26, "Key_DownArrow": 0x28, "Key_LeftArrow": 0x25, "Key_RightArrow": 0x27,
    "Key_Insert": 0x2D, "Key_Delete": 0x2E, "Key_Home": 0x24, "Key_End": 0x23, "Key_PageUp": 0x21, "Key_PageDown": 0x22,
    "Key_Minus": 0xBD, "Key_Equals": 0xBB, "Key_Comma": 0xBC, "Key_Period": 0xBE, "Key_Slash": 0xBF,
    "Key_SemiColon": 0xBA, "Key_Apostrophe": 0xDE, "Key_Grave": 0xC0, "Key_LeftBracket": 0xDB,
    "Key_RightBracket": 0xDD, "Key_BackSlash": 0xDC,
})


def _hk_bindings_dir():
    home = os.path.expanduser("~")
    for d in (
        os.path.join(os.environ.get("LOCALAPPDATA", ""), "Frontier Developments", "Elite Dangerous", "Options", "Bindings"),
        os.path.join(home, "Library", "Application Support", "Frontier Developments", "Elite Dangerous", "Options", "Bindings"),
        os.path.join(home, ".local", "share", "Frontier Developments", "Elite Dangerous", "Options", "Bindings"),
    ):
        if d and os.path.isdir(d):
            return d
    return None


def _hk_presets(bdir):
    names = []
    for c in sorted(_glob.glob(os.path.join(bdir, "StartPreset*.start")), reverse=True):
        try:
            with open(c, "r", encoding="utf-8", errors="ignore") as f:
                raw = f.read()
        except Exception:
            continue
        for tok in raw.replace("/", "\n").splitlines():
            tok = tok.strip().strip('"')
            if tok and tok not in names:
                names.append(tok)
        if names:
            break
    return names


def _hk_find_binds(bdir, fire):
    allb = _glob.glob(os.path.join(bdir, "*.binds"))
    if not allb:
        return None

    def has(p):
        try:
            with open(p, "r", encoding="utf-8", errors="ignore") as f:
                return ("<" + fire + ">") in f.read()
        except Exception:
            return False
    for nm in _hk_presets(bdir):
        for p in allb:
            b = os.path.basename(p)
            if (b == nm + ".binds" or b.startswith(nm + ".")) and has(p):
                return p
    for p in sorted(allb, key=lambda x: os.path.getmtime(x), reverse=True):
        if has(p):
            return p
    return sorted(allb, key=lambda x: os.path.getmtime(x), reverse=True)[0]


def _hk_parse(path):
    import xml.etree.ElementTree as ET
    out = {}
    try:
        root = ET.parse(path).getroot()
    except Exception:
        return out

    def rb(el):
        if el is None or not el.get("Key"):
            return None
        return {"device": el.get("Device"), "key": el.get("Key"),
                "mods": [m.get("Key") for m in el.findall("Modifier") if m.get("Key")]}
    for ctl in root:
        p, s = ctl.find("Primary"), ctl.find("Secondary")
        if p is None and s is None:
            continue
        out[ctl.tag] = {"primary": rb(p), "secondary": rb(s)}
    return out


def _hk_resolve_key(binds, control):
    c = binds.get(control)
    if not c:
        return None
    for slot in ("primary", "secondary"):
        b = c.get(slot)
        if b and (b.get("device") or "").lower() == "keyboard" and b.get("key"):
            return (b["key"], b.get("mods", []))
    return None


def _hk_resolve():
    """Resolve the honk key from the pilot's binds; cache it. Safe to re-call."""
    try:
        bdir = _hk_bindings_dir()
        if not bdir:
            return False
        path = _hk_find_binds(bdir, _honk_fire())
        if not path:
            return False
        res = _hk_resolve_key(_hk_parse(path), _honk_fire())
        if not res:
            _set_status("honk: no keyboard bind on " + _honk_fire())
            return False
        key, mods = res
        sc = _HK_SC.get(key)
        if not sc:
            _set_status("honk: key " + str(key) + " unmapped")
            return False
        _hk["key"] = key
        _hk["sc"] = sc
        _hk["vk"] = _HK_VK.get(key)
        _hk["mods"] = [(_HK_SC[m][0], _HK_SC[m][1], _HK_VK.get(m)) for m in mods if m in _HK_SC]
        _hk["resolved"] = True
        return True
    except Exception:
        return False


def _hk_send(vk, scan, ext, up):
    try:
        import ctypes
        ctypes.windll.user32.keybd_event(vk or 0, scan or 0, (1 if ext else 0) | (2 if up else 0), 0)
    except Exception:
        pass


def _hk_tap(vk, scan, ext, hold):
    # press-hold-release: ED drops keys that go down+up instantly (the honk lesson)
    _hk_send(vk, scan, ext, False)
    time.sleep(hold)
    _hk_send(vk, scan, ext, True)


def _gm_elite_rect():
    try:
        import ctypes, ctypes.wintypes
        u = ctypes.windll.user32
        h = u.GetForegroundWindow()
        r = ctypes.wintypes.RECT()
        u.GetWindowRect(h, ctypes.byref(r))
        return r.left, r.top, r.right - r.left, r.bottom - r.top
    except Exception:
        return None


def _gm_click(fx, fy):
    # click the galaxy-map search box, positioned as a fraction of Elite's window
    # (window-relative so it survives resolution / windowed vs borderless changes)
    try:
        import ctypes
        rect = _gm_elite_rect()
        if not rect:
            return False
        left, top, w, h = rect
        x = int(left + fx * w)
        y = int(top + fy * h)
        u = ctypes.windll.user32
        u.SetCursorPos(x, y)
        time.sleep(0.05)
        u.mouse_event(0x0002, 0, 0, 0, 0)   # left button down
        time.sleep(0.04)
        u.mouse_event(0x0004, 0, 0, 0, 0)   # left button up
        return True
    except Exception:
        return False


def _hk_elite_foreground():
    """Is Elite ACTUALLY the foreground window? Every key-sending assist depends on this,
    because keybd_event injects into whatever has focus and cannot target a window.

    ⚠ b3.15 TIGHTENED THIS. It used to be `"elite" in window_title.lower()`, which is
    satisfied by a **browser tab titled "Elite Dangerous wiki"**, a Discord channel named
    #elite, or an editor with an elite-something file open. Any of those being focused would
    have let honk fire, or galaxy-paste type Ctrl+G / Ctrl+V / Enter / Escape into it. The
    guard existed and was correct in spirit; the match was just too loose to keep its promise.

    Now shares one window-identification routine with the refocus code (`_rf_pick_elite`),
    which requires the title to START with "elite - dangerous" or the Frontier window class —
    and has a test asserting the Chrome-wiki-tab case does NOT match."""
    if os.name != "nt":
        return False
    try:
        h = _rf_pick_elite(_rf_enum_windows())
        if not h:
            return False
        import ctypes
        return ctypes.windll.user32.GetForegroundWindow() == h
    except Exception:
        return False


def _hk_hold():
    sc, ext = _hk["sc"]
    vk = _hk["vk"]
    for ms, me, mvk in _hk["mods"]:
        _hk_send(mvk, ms, me, False)
    _hk_send(vk, sc, ext, False)
    end = time.time() + _HK_HOLD_S
    while time.time() < end:
        time.sleep(min(_HK_REASSERT, max(0.0, end - time.time())))
        if time.time() < end:
            _hk_send(vk, sc, ext, False)
    _hk_send(vk, sc, ext, True)
    for ms, me, mvk in reversed(_hk["mods"]):
        _hk_send(mvk, ms, me, True)


def _hk_do_honk(sa):
    try:
        if os.name != "nt" or not _honk_on():
            return
        if sa in _hk["honked"]:
            return
        if not _hk["resolved"] and not _hk_resolve():
            return
        if not _hk_elite_foreground():
            _set_status("honk skipped (Elite not focused)")
            return
        fl = _hk["flags"]
        if fl is not None:
            if fl & _HK_FLAG_DOCKED:
                return
            if fl & _HK_FLAG_HARDPOINTS:
                _set_status("honk skipped (hardpoints out)")
                return
        _hk["honked"].add(sa)
        _set_status("honk! (" + str(_hk["key"]) + ")")
        _hk_hold()
    except Exception:
        pass


def _hk_arrival(sa):
    if os.name != "nt" or not _honk_on() or sa is None or sa in _hk["honked"]:
        return
    try:
        threading.Timer(_HK_DELAY_S, _hk_do_honk, args=(sa,)).start()
    except Exception:
        pass



# --- galaxy-map paste (BladeRelay assist: plot-to-system) -------------------
# On a nav target (from the board's NAV/Inara buttons -> navpull -> clipboard), if
# enabled, open the galaxy map and paste the system. Reuses the honk binds parser to
# read the pilot's Open-Galaxy-Map key; the paste is Ctrl+V. Runs OFF the Tk thread.
# --- galaxy-paste tuning (b2.9) — keyboard-nav route; iterate live with Adam ---
_GM_OPEN_HOLD = 0.10     # hold the Open-Galaxy-Map key (an instant tap gets ignored by ED)
_GM_AFTER_OPEN = 1.8     # wait for the map to animate open before navigating
_GM_KEY_HOLD = 0.08      # hold for each UI-nav / UI-select key
_GM_NAV_UP = 1           # UI_Up presses to move the highlight to the search box (from a fresh map)
_GM_BETWEEN_NAV = 0.12   # pause between UI_Up presses
_GM_AFTER_NAV = 0.30     # pause after highlighting, before selecting the search box
_GM_AFTER_SELECT = 0.35  # pause after selecting (search field active) before pasting
_GM_V_HOLD = 0.08        # hold V under Ctrl for the paste
_GM_DO_ENTER = True      # press Enter after paste to run the search (safe once the field is focused)
_GM_BEFORE_ENTER = 1.5   # WAIT for EDs search to actually FIND the pasted system before Enter
                         # (~1s; Enter fired too soon goes nowhere and loses the map)
# --- multi-result fix (Adam, 2026-08-15, found while flying) -----------------
# ED's search dropdown opens with NO row focused, so Enter has nothing to act on and the
# whole plot silently does nothing. The single-match case only ever worked by accident:
# with one candidate the field resolves on its own.
# One UI_Down moves onto the first row, and THEN Enter selects it.
# ⚠ This is NOT an edge case: `COL 285 SECTOR QX-S C4-1` is a prefix of C4-10 ... C4-19, and
# most of the galaxy outside the bubble is named like that.
# Adam's manual path also falls out of it — if row one is wrong he can keep arrowing before
# the confirm lands.
_GM_DOWN_INTO_LIST = True  # press UI_Down after the search settles, before Enter
_GM_AFTER_DOWN = 0.25      # let the highlight land on row one before confirming
_GM_ENTER_HOLD = 0.12    # hold Enter long enough for ED to register the search-submit (0.06 was too short)
# --- select + plot the searched system (the tail) ---
_GM_AFTER_SEARCH = 2.5   # wait after Enter for the map to pan to the system (far systems take a few seconds)
_GM_ZOOM_CTRL = "CamZoomIn"  # control whose key nudge-zooms to SELECT the system under the cursor (Z; CamZoomOut/X also works)
_GM_ZOOM_HOLD = 0.10     # brief zoom tap to select the system
_GM_AFTER_ZOOM = 0.40    # wait after the zoom-select before plotting
_GM_PLOT_HOLD = 3.0      # HOLD UI_Select this long to fully plot the route (bump to 4.0 if too short)
_GM_AFTER_PLOT = 0.40    # wait after plotting before closing the map
_GM_CLOSE_MAP = True     # leave the map when done
_GM_CLOSE_ESC = 2        # Escape presses to back out (Adam: "2 escapes work"; UI_Back a couple times also works)
_GM_OPEN_KEY = None      # OPTIONAL hard override of the open-map key (ED name, e.g. "Key_G").
_GM_OPEN_MODS = ()       # modifiers for the override. DEFAULT None/() = resolve each pilot's OWN
                         # Galaxy Map / UI_Up / UI_Select keyboard binds from their .binds. No hardcoding.

# resolved per-pilot keys: each = {"key","sc","ext","vk","mods"} or None
_gm = {"open": None, "up": None, "down": None, "select": None, "zoom": None, "resolved": False}


def _gm_resolve_ctrl(control, override=None, override_mods=()):
    # Resolve ONE control to a pressable keyboard key (+modifiers) from THIS pilot's binds.
    # Returns {"key","sc","ext","vk","mods":[(sc,ext,vk),...]} or None (no keyboard bind).
    try:
        if override and override in _HK_SC:
            key, mods = override, list(override_mods)
        else:
            bdir = _hk_bindings_dir()
            if not bdir:
                return None
            path = _hk_find_binds(bdir, control)
            if not path:
                return None
            res = _hk_resolve_key(_hk_parse(path), control)
            if not res:
                return None
            key, mods = res
        scext = _HK_SC.get(key)
        if not scext:
            return None
        return {"key": key, "sc": scext[0], "ext": scext[1], "vk": _HK_VK.get(key),
                "mods": [(_HK_SC[m][0], _HK_SC[m][1], _HK_VK.get(m)) for m in mods if m in _HK_SC]}
    except Exception:
        return None


def _gm_resolve():
    _gm["open"] = _gm_resolve_ctrl("GalaxyMapOpen", _GM_OPEN_KEY, _GM_OPEN_MODS)
    _gm["up"] = _gm_resolve_ctrl("UI_Up")
    _gm["down"] = _gm_resolve_ctrl("UI_Down")
    _gm["select"] = _gm_resolve_ctrl("UI_Select")
    _gm["zoom"] = _gm_resolve_ctrl(_GM_ZOOM_CTRL)
    # ⚠ "down" is deliberately NOT in the readiness test below. It only improves the
    # multi-result case; a pilot with no keyboard UI_Down bind should still get the assist
    # they had before rather than lose it. Adding it here would silently disarm working rigs.
    _gm["resolved"] = bool(_gm["open"] and _gm["up"] and _gm["select"] and _gm["zoom"])
    return _gm["resolved"]


def _gm_press(k, hold):
    # press a resolved control: modifier(s) down -> key held -> modifier(s) up
    if not k:
        return
    for _ms, _me, _mvk in k["mods"]:
        _hk_send(_mvk, _ms, _me, False)
    _hk_tap(k["vk"], k["sc"], k["ext"], hold)
    for _ms, _me, _mvk in reversed(k["mods"]):
        _hk_send(_mvk, _ms, _me, True)


def _gm_hold(k, seconds):
    # HOLD a resolved control for N seconds, re-asserting like honk (ED drops long
    # single-event holds). Used for the "hold to fully plot" progress bar.
    if not k:
        return
    for _ms, _me, _mvk in k["mods"]:
        _hk_send(_mvk, _ms, _me, False)
    _hk_send(k["vk"], k["sc"], k["ext"], False)
    end = time.time() + seconds
    while time.time() < end:
        time.sleep(min(_HK_REASSERT, max(0.0, end - time.time())))
        if time.time() < end:
            _hk_send(k["vk"], k["sc"], k["ext"], False)   # re-assert while held
    _hk_send(k["vk"], k["sc"], k["ext"], True)
    for _ms, _me, _mvk in reversed(k["mods"]):
        _hk_send(_mvk, _ms, _me, True)


def _gm_missing_binds():
    # Keybinds THIS pilot must have for the galaxy-paste sequence; empty list = ready.
    # The whole sequence is keyboard: open the map, UI_Up to the search box, UI_Select it.
    _gm["open"] = _gm_resolve_ctrl("GalaxyMapOpen", _GM_OPEN_KEY, _GM_OPEN_MODS)
    _gm["up"] = _gm_resolve_ctrl("UI_Up")
    _gm["down"] = _gm_resolve_ctrl("UI_Down")
    _gm["select"] = _gm_resolve_ctrl("UI_Select")
    _gm["zoom"] = _gm_resolve_ctrl(_GM_ZOOM_CTRL)
    # UI_Down is NOT required — see _gm_resolve(). It is reported as an advisory below so a
    # pilot can see WHY multi-result searches still miss for them, without being blocked.
    _gm["resolved"] = bool(_gm["open"] and _gm["up"] and _gm["select"] and _gm["zoom"])
    missing = []
    if not _gm["open"]:
        missing.append("a keyboard key on 'Galaxy Map'")
    if not _gm["up"]:
        missing.append("a keyboard key on 'UI Panel Up'")
    if not _gm["select"]:
        missing.append("a keyboard key on 'UI Select'")
    if not _gm["zoom"]:
        missing.append("a keyboard key on 'Galaxy Cam Zoom In'")
    return missing


def _gm_down_advisory():
    # NOT a blocker -- an explanation. Without a keyboard 'UI Panel Down' the sequence still
    # runs, but a search returning several systems cannot be stepped into, so those plots
    # quietly do nothing. Better the pilot is told why than left guessing.
    return "" if _gm.get("down") else "no keyboard key on 'UI Panel Down' - searches that match several systems will not plot"



def _gm_ready():
    return not _gm_missing_binds()


def _hk_missing_binds():
    # Honk readiness: empty list = ready. Honk needs a KEYBOARD bind on the pilot's fire
    # control that we can map to a scancode (keybd_event can't press a HOTAS). Mirrors the
    # checks in _hk_resolve without disturbing its cached state.
    try:
        bdir = _hk_bindings_dir()
        path = _hk_find_binds(bdir, _honk_fire()) if bdir else None
        res = _hk_resolve_key(_hk_parse(path), _honk_fire()) if path else None
        if res and _HK_SC.get(res[0]):
            return []
    except Exception:
        pass
    return ["a keyboard key on your fire control (Discovery Scanner)"]


def _assist_readiness():
    # Compact per-assist readiness for the heartbeat query string. Only assists that press
    # an in-game control report here (r=1 ready / r=0 not; m=[human strings to set]); every
    # other assist is implicitly ready. Kept tiny so it fits comfortably in the URL.
    out = {}
    try:
        hm = _hk_missing_binds()
        out["honk"] = {"r": 0 if hm else 1, "m": hm}
    except Exception:
        pass
    try:
        gm = _gm_missing_binds()
        out["galaxymap"] = {"r": 0 if gm else 1, "m": gm}
    except Exception:
        pass
    return out


def _status_label(flags):
    # Friendly flight state from the Status.json Flags bitfield (honk already tracks it).
    if not isinstance(flags, int):
        return ""
    if flags & 0x1:
        return "Docked"
    if flags & 0x2:
        return "Landed"
    if flags & 0x10:
        return "Supercruise"
    return "In flight"


def _assist_telemetry():
    # Compact LIVE telemetry for the MY DASHBOARD tile row, assembled entirely from state
    # the plugin ALREADY tracks (journal + Status.json) — no new hooks. Everything is
    # best-effort: a missing piece is just omitted so the tile shows a dash.
    out = {}
    # Only report while Elite is in a LIVE session. Status.json Flags == 0 is the main-menu /
    # exit state (real flight always carries other bits); flags is None before we've seen a
    # status at all. Reporting then would push a stale system + a false "In flight" that the
    # dashboard paints green and LIVE with EDMC up but Elite closed. Empty -> nothing sent ->
    # the strip greys out on its own, which is the correct offline state.
    _fl = _hk.get("flags")
    if not isinstance(_fl, int) or _fl == 0:
        return out
    # b3.23 — the board uses this to work out whether IT is on the cockpit PC. If the plugin
    # reports a refocus that SUCCEEDED and the browser never lost focus, that browser is on a
    # different machine and its ↵ GAME button is pointless furniture. Reporting the outcome is
    # what makes that inference sound: without it, "focus did not move here" is ambiguous
    # between "wrong machine" and "Windows refused", and those want opposite responses.
    # rfAt is the RIG's clock and is NEVER compared against the browser's — the board only
    # watches for the VALUE CHANGING. Two clocks, one comparison, is the bug we already shipped
    # once in the freshness gate.
    try:
        if _rf.get("at"):
            out["rfAt"] = int(float(_rf["at"]) * 1000)
            out["rfRung"] = str(_rf.get("last") or "")[:16]
    except Exception:
        pass
    try:
        if _state.get("system"):
            out["sys"] = str(_state["system"])[:64]
    except Exception:
        pass
    try:
        if _LO.get("ship"):
            out["ship"] = str(_LO["ship"])[:32]
        if _LO.get("shipName"):
            out["shipName"] = str(_LO["shipName"])[:48]
        if _LO.get("cargoCap") is not None:
            out["cargoCap"] = int(_LO["cargoCap"])
        if _LO.get("cargoUsed") is not None:
            out["cargo"] = int(_LO["cargoUsed"])
    except Exception:
        pass
    try:
        m, c = _fuel.get("main"), _fuel.get("cap")
        if m is not None and c:
            out["fuelPct"] = max(0, min(100, int(round(float(m) / float(c) * 100))))
    except Exception:
        pass
    try:
        lbl = _status_label(_hk.get("flags"))
        if lbl:
            out["status"] = lbl
    except Exception:
        pass
    return out


def _gm_paste():
    try:
        if os.name != "nt" or not _galaxymap_on():
            return
        # smart abandon: if the pilot lacks a key the sequence needs, do NOTHING
        # (never fire a half sequence -> a stray Enter opens comms chat).
        miss = _gm_missing_binds()
        if miss:
            _set_status("galaxy-paste needs " + ", ".join(miss) + " - set in ED controls")
            return
        if not _hk_elite_foreground():
            _set_status("galaxy-paste skipped (Elite not focused)")
            return
        o, u, sel = _gm["open"], _gm["up"], _gm["select"]
        _set_status("galaxy-paste: opening map (" + str(o["key"]) + ")")
        _gm_press(o, _GM_OPEN_HOLD)                 # open the galaxy map
        time.sleep(_GM_AFTER_OPEN)
        for _i in range(max(1, _GM_NAV_UP)):        # navigate up to highlight the search box
            _gm_press(u, _GM_KEY_HOLD)
            time.sleep(_GM_BETWEEN_NAV)
        time.sleep(_GM_AFTER_NAV)
        _gm_press(sel, _GM_KEY_HOLD)                # UI-select -> activate the search field
        time.sleep(_GM_AFTER_SELECT)
        _hk_send(0xA2, 0x1D, 0, False)              # Ctrl down
        _hk_tap(0x56, 0x2F, 0, _GM_V_HOLD)          # V -> paste
        _hk_send(0xA2, 0x1D, 0, True)               # Ctrl up
        if _GM_DO_ENTER:
            _hk_send(0xA2, 0x1D, 0, True)            # re-assert Ctrl release so Enter isnt read as Ctrl+Enter
            time.sleep(_GM_BEFORE_ENTER)            # let the pasted text settle
            # Step INTO the results list first. Without this, a multi-match search leaves the
            # dropdown open with nothing highlighted and the Enter below is a no-op.
            # Degrades quietly: no UI_Down bind -> skip it and behave exactly as before,
            # rather than disabling the whole assist over one missing keyboard bind.
            if _GM_DOWN_INTO_LIST and _gm.get("down"):
                _gm_press(_gm["down"], _GM_KEY_HOLD)
                time.sleep(_GM_AFTER_DOWN)
            _hk_tap(0x0D, 0x1C, 0, _GM_ENTER_HOLD)  # Enter -> select the highlighted row
        _set_status("galaxy-paste: searching -> select + plot")
        time.sleep(_GM_AFTER_SEARCH)                # map pans to the searched system
        _gm_press(_gm["zoom"], _GM_ZOOM_HOLD)       # nudge-zoom to SELECT the system under the cursor
        time.sleep(_GM_AFTER_ZOOM)
        _gm_hold(sel, _GM_PLOT_HOLD)                # HOLD UI_Select to fully plot the route (~3s)
        time.sleep(_GM_AFTER_PLOT)
        if _GM_CLOSE_MAP:
            for _e in range(max(1, _GM_CLOSE_ESC)):
                _hk_tap(0x1B, 0x01, 0, _GM_KEY_HOLD)   # Escape -> back out of the map (x2)
                time.sleep(_GM_BETWEEN_NAV)
        _set_status("galaxy-map: route plotted")
    except Exception:
        pass


# --- fuel safety check (BladeRelay assist) ----------------------------------
# --- alerts lane + the PIRATE ALARM (BladeRelay) ----------------------------
# ONE shared alert lane. Any feature can raise an alert; alerts ride the existing navpull
# heartbeat (&al=) into KV and out to the MY DASHBOARD alerts strip, which glows and sounds
# its own klaxon. Levels use the Systems-Register vocabulary the rest of the board already
# speaks: critical (red) / warn (amber) / info (grey). Held as a bounded ring so a noisy
# instance can never grow the heartbeat URL.
_ALERT_MAX = 6            # most recent alerts carried on the heartbeat
_ALERT_MSG_MAX = 90       # message chars; the strip truncates anyway — keep the URL small
_alerts = []              # newest LAST: [{"i":id,"l":level,"m":msg,"t":ms}]
_alert_state = {"seq": 0, "cool": {}}

try:
    import winsound as _winsound        # Windows only — the PC klaxon no-ops elsewhere
except Exception:
    _winsound = None

# The PC-side klaxon — an F-16 RWR-style LAUNCH WARBLE (test-pilot call, 2026-08-09), matched
# tone-for-tone to the browser klaxon in _shell/telemetry.js (OB_TONES) so the rig and the board
# make the SAME noise. The "deedle deedle" is alternating pitch, not a single repeated beep.
#
# Format: (freq_hz, milliseconds); freq 0 means SILENCE (winsound.Beep cannot emit a rest, so a
# gap is a sleep). Kept on winsound.Beep rather than a mixer-routed WAV on purpose: Beep proved
# loud enough to carry over a running Elite (verified 2026-08-09), and PlaySound would put the
# alarm back under the volume mixer where the game can bury it.
# The same three threat tones the board offers, so whichever one wins the A/B on the board can
# be matched here without a code change — set `blades_alarm_tone` to warble|lock|growl in EDMC
# settings. (The board's picker is per-device localStorage and deliberately does NOT drive the
# rig: syncing it would mean pushing a STRING through a settings pipe that is boolean-only.)
_KLAXON_TONES = {
    "warble": [(1046, 45), (0, 28), (1245, 45), (0, 28)] * 10,     # ~1.46s, mirrors OB_TONES.warble
    "lock": [(1000, 70), (0, 55)] * 12,                            # mirrors OB_TONES.lock
    "growl": [(150, 60), (190, 60), (240, 60), (0, 50)]            # a Beep can't buzz — closest is a rising
             + [(1046, 45), (0, 28), (1245, 45), (0, 28)] * 5,     # sweep into the warble
}
DEFAULT_ALARM_TONE = "warble"


def _alarm_tone():
    t = _cfg_str("blades_alarm_tone", DEFAULT_ALARM_TONE).strip().lower()
    return t if t in _KLAXON_TONES else DEFAULT_ALARM_TONE


def _klaxon_pattern(level):
    if level == "critical":
        return _KLAXON_TONES[_alarm_tone()]
    if level == "warn":
        return [(660, 100), (0, 90), (660, 100)]                   # mirrors OB_TONES.soft
    return None


def _alarm_blare(level):
    """Sound the klaxon on THIS PC. Always on its own daemon thread — winsound.Beep is
    BLOCKING, and the journal callback must never sit through a 1.5s warble."""
    if not PIRATE_BLARE or _winsound is None:
        return
    pattern = _klaxon_pattern(level)
    if not pattern:
        return

    def _run():
        try:
            for freq, ms in pattern:
                if freq:
                    _winsound.Beep(int(freq), int(ms))
                else:
                    time.sleep(ms / 1000.0)
        except Exception:
            pass
    try:
        threading.Thread(target=_run, daemon=True).start()
    except Exception:
        pass


def _alert_raise(level, msg, key=None, cooldown=0.0, blare=False):
    """Raise one alert. `key` + `cooldown` de-bounce a repeating source — a pirate can
    re-scan you every few seconds, and a siren that never stops is a siren you turn off.
    While cooling, the alert is dropped entirely (not queued). Returns True if raised."""
    try:
        now = time.time()
        if key and cooldown:
            if (now - _alert_state["cool"].get(key, 0.0)) < cooldown:
                return False
            _alert_state["cool"][key] = now
        _alert_state["seq"] += 1
        text = str(msg or "")[:_ALERT_MSG_MAX]
        _alerts.append({
            "i": str(int(now * 1000)) + "-" + str(_alert_state["seq"]),
            "l": str(level or "info")[:10],
            "m": text,
            "t": int(now * 1000),
        })
        del _alerts[:-_ALERT_MAX]        # bounded ring: keep only the newest _ALERT_MAX
        _set_status(text)
        if blare:
            _alarm_blare(level)
        return True
    except Exception:
        return False


def _alerts_payload():
    """The alert ring as the heartbeat sends it — a plain list, newest last."""
    return list(_alerts)


# --- b3.11: give the stick back ---------------------------------------------
# Elite receives NOTHING from the stick while unfocused — not buttons, not axes. So any
# pilot running the board on a second monitor of the GAME rig is disarmed the moment they
# touch it, and the pirate alarm is precisely the wrong time to be reaching for a screen.
#
# ⚠ THE TWO PATHS ARE NOT EQUALLY RELIABLE, and pretending otherwise would be the bug.
# Windows only lets SetForegroundWindow succeed for a process with a claim on the
# foreground — most usefully, one that received the last input event.
#   * HOTKEY path  -> the user's keypress IS that claim. This should just work.
#   * ALARM path   -> a journal event on a background thread has no claim at all. It falls
#                     back to the AttachThreadInput trick, which usually works and sometimes
#                     does not. It reports the outcome rather than failing silently.
_RF_MODS = {"alt": 0x0001, "ctrl": 0x0002, "control": 0x0002, "shift": 0x0004, "win": 0x0008}
_RF_DEFAULT_HOTKEY = "ctrl+alt+e"
_rf = {"thread": None, "stop": False, "spec": "", "state": "off", "why": "",
       "last": "", "at": 0.0}


def _refocus_on():
    try:
        return bool(_srv["refocus"])
    except Exception:
        return False


def _rf_parse_hotkey(spec):
    """PURE. 'ctrl+alt+e' -> (modifiers, virtual-key). (0, 0) when unparseable.
    Kept free of Windows calls so the parsing can be tested anywhere."""
    mods, vk = 0, 0
    for part in str(spec or "").lower().replace(" ", "").split("+"):
        if not part:
            continue
        if part in _RF_MODS:
            mods |= _RF_MODS[part]
        elif len(part) == 1 and (part.isalpha() or part.isdigit()):
            vk = ord(part.upper())
        elif part.startswith("f") and part[1:].isdigit() and 1 <= int(part[1:]) <= 24:
            vk = 0x70 + int(part[1:]) - 1
        else:
            return (0, 0)                      # unknown token: refuse rather than guess
    return (mods, vk) if vk else (0, 0)


def _rf_pick_elite(windows):
    """PURE. From [(hwnd, title, cls)] pick Elite's main window; 0 if absent.
    Title first (stable across launcher versions), window class as the fallback."""
    for hwnd, title, cls in windows:
        if str(title or "").strip().lower().startswith("elite - dangerous"):
            return hwnd
    for hwnd, title, cls in windows:
        if "frontierdevelopments" in str(cls or "").lower() and str(title or "").strip():
            return hwnd
    return 0


def _rf_enum_windows():
    """Windows only. Returns [(hwnd, title, cls)] for visible top-level windows."""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    out = []
    CB = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)

    def cb(hwnd, _l):
        try:
            if not u.IsWindowVisible(hwnd):
                return True
            n = u.GetWindowTextLengthW(hwnd)
            t = ctypes.create_unicode_buffer(n + 1)
            u.GetWindowTextW(hwnd, t, n + 1)
            c = ctypes.create_unicode_buffer(256)
            u.GetClassNameW(hwnd, c, 256)
            out.append((hwnd, t.value, c.value))
        except Exception:
            pass
        return True

    u.EnumWindows(CB(cb), 0)
    return out


def _rf_now(hwnd):
    """Did the foreground ACTUALLY move? SetForegroundWindow can return non-zero and change
    nothing, so every rung below is judged on the observed result, never the return value."""
    try:
        import ctypes
        return ctypes.windll.user32.GetForegroundWindow() == hwnd
    except Exception:
        return False


def _rf_alt_tap():
    """Press and release ALT. Windows relaxes the foreground lock around menu interaction,
    so a synthesized Alt gives the next SetForegroundWindow a fighting chance. Same family
    of idea as sending Alt+Tab, but it lets us keep naming Elite explicitly."""
    try:
        _hk_send(0x12, 0, False, False)      # VK_MENU down
        time.sleep(0.03)
        _hk_send(0x12, 0, False, True)       # up
        time.sleep(0.03)
    except Exception:
        pass


def _rf_alt_tab():
    """LAST RESORT. Alt+Tab goes to the most-recently-used window, NOT to Elite — if the
    pilot glanced at Discord in between, that is where this lands. It is only ever called
    after we have confirmed Elite is not already foreground; firing it while Elite IS in
    front would throw them OUT of the game, which is the precise opposite of the job."""
    try:
        _hk_send(0x12, 0, False, False)      # Alt down
        time.sleep(0.04)
        _hk_send(0x09, 0, False, False)      # Tab down
        time.sleep(0.06)
        _hk_send(0x09, 0, False, True)       # Tab up
        time.sleep(0.04)
        _hk_send(0x12, 0, False, True)       # Alt up
        time.sleep(0.15)                     # let the shell finish the switch
    except Exception:
        pass


def _elite_hwnd():
    if os.name != "nt":
        return 0
    try:
        return _rf_pick_elite(_rf_enum_windows())
    except Exception:
        return 0


def _elite_focused():
    """★ THE GUARD FOR EVERY KEY-SENDING ASSIST. keybd_event injects into whatever window is
    focused — it cannot target Elite. Without this check, honk or galaxy-paste firing while
    the board has focus types Ctrl+G / Ctrl+V / Enter / Escape into a BROWSER."""
    if os.name != "nt":
        return True                          # non-Windows rigs do not run the key assists
    h = _elite_hwnd()
    return bool(h) and _rf_now(h)


def _rf_won(rung):
    """Record and ANNOUNCE which method actually moved the foreground.

    b3.15 stored this in `_rf["last"]` and surfaced it nowhere, so the winning rung had to be
    deduced from window ordering after the fact. Which rung works is the single most useful
    thing to know here — it differs by Windows build and by what else is running — so it is
    now stated. Once per hour per rung, so a change of behaviour still gets reported."""
    _rf["last"] = rung
    _rf["at"] = time.time()
    _set_status("refocus OK via " + rung)
    # b3.27 - the hourly "Refocus succeeded via X" INFO ALERT is gone. Which rung wins was the
    # open question through b3.11-b3.15 and it is answered; an alert announcing routine
    # success is noise in a lane whose entire value is that its contents mean something. The
    # rung is still stamped into _rf["last"] and still rides the heartbeat as rfRung, so the
    # board and the cockpit detection lose nothing.
    return True


def _refocus_to_elite(why=""):
    """Hand the foreground back to Elite, escalating and verifying at every step.
    Returns True only when the foreground is OBSERVED to be Elite afterwards."""
    # b3.26 — STAMP EVERY FAILURE BRANCH, not just the refused one. `_rf["last"]` is now
    # read as a REASON (the pirate alarm gates its hotkey hint on it), and an unstamped
    # branch leaves the PREVIOUS outcome standing — so a refusal at 20:00 would still be
    # answering for a "game isn't running" at 20:05. Same lesson as b3.25: an outcome that
    # records nothing is indistinguishable from one that never happened.
    if os.name != "nt":
        _rf["last"] = "nonwindows"
        return False
    try:
        hwnd = _elite_hwnd()
        if not hwnd:
            _rf["last"] = "nogame"
            _set_status("refocus: Elite window not found")
            return False
        if _rf_now(hwnd):
            # b3.25 — STAMP THIS PATH TOO. "Elite already has the foreground" is an OUTCOME,
            # not a no-op, and it is the single most informative one the board can receive:
            # if the plugin says Elite holds focus and the browser that asked never lost it,
            # that browser is not on this machine. Leaving it unstamped made the cockpit
            # detection unable to fire from precisely the case it exists for — a press from a
            # tablet or a second PC never moves the rig's foreground, so it always landed
            # here, reported nothing, and the board waited out its window forever.
            _rf["last"] = "already"
            _rf["at"] = time.time()
            return True                      # already there — and the alt-tab rung is unsafe
        import ctypes
        u = ctypes.windll.user32
        u.ShowWindow(hwnd, 9)                # SW_RESTORE if minimised

        # rung 1 — the honest call. Works when we already hold a claim (the hotkey path).
        u.SetForegroundWindow(hwnd)
        if _rf_now(hwnd):
            return _rf_won("direct")

        # rung 2 — Alt-tap, then ask again. Targeted, no window-order guessing.
        _rf_alt_tap()
        u.SetForegroundWindow(hwnd)
        if _rf_now(hwnd):
            return _rf_won("alt-tap")

        # rung 3 — borrow the foreground thread's input queue.
        try:
            k = ctypes.windll.kernel32
            cur = u.GetWindowThreadProcessId(u.GetForegroundWindow(), None)
            me = k.GetCurrentThreadId()
            if u.AttachThreadInput(cur, me, True):
                try:
                    u.SetForegroundWindow(hwnd)
                finally:
                    u.AttachThreadInput(cur, me, False)
            if _rf_now(hwnd):
                return _rf_won("attach")
        except Exception:
            pass

        # rung 4 — Alt+Tab. Safe here ONLY because Elite is confirmed not foreground.
        _rf_alt_tab()
        if _rf_now(hwnd):
            return _rf_won("alt-tab")

        _rf["last"] = "failed"       # ← the ONLY value that means "Windows refused a game
        _rf["at"] = time.time()      #   that IS there"; the hint gate keys on exactly this
        _set_status("refocus FAILED (Windows refused foreground, all 4 methods)")
        return False
    except Exception:
        _rf["last"] = "error"
        _set_status("refocus error")
        return False


# --- b3.21: refocus on ACTIVATION, never on attention ------------------------
# Adam's rule, and it is the right one: taking the stick back should follow something you
# DID on the board — a NAV send, flipping an assist — and never follow merely looking at it.
# Scrolling, reading, tile refreshes and alert polls must never move the foreground.
#
# ★ THE HARD PART IS NOT DECIDING, IT IS TIMING. The plugin only learns about a board action
# on its 5s heartbeat, so a naive implementation refocuses up to 5 seconds after the click —
# by which time you have moved on to reading something else, which is EXACTLY the behaviour
# the rule exists to prevent. Two gates, and they guard different things:
#
#   * FRESHNESS (`RF_ACT_MAX_AGE_S`) is REPLAY protection, not latency control. The normal
#     case is already bounded by the poll interval. The case it catches: EDMC restarts,
#     `_nav["last_ts"]` resets to 0, and a `nav:` record still inside its 600s KV TTL reads
#     as brand new — a click from nine minutes ago yanking you out of the game. Same failure
#     class as the handoff bridge's resurrection guard, and the same fix: trust the stamped
#     time, not arrival. Sized ABOVE the poll interval on purpose — a gate tight enough to
#     drop honest clicks would make the feature fire ~60% of the time, and intermittent is
#     worse than absent.
#   * PRIMING (`_rfa["primed"]`) covers the other replay: a plugin that was off while the
#     settings changed sees a difference on its first poll that is history, not intent. The
#     first poll of a session establishes the baseline and can never refocus.
#
# Both fail CLOSED — an unparseable or missing timestamp does not refocus. That is the
# opposite of the bridge's resurrection guard, deliberately: there, dropping work silently
# was the worse outcome; here, stealing the foreground is.
RF_ACT_MAX_AGE_S = 20.0        # a nav push older than this is replay, not intent
RF_ACT_COOLDOWN_S = 8.0        # a burst of activations is ONE refocus, not five
_RF_AGE_UNKNOWN = float("inf")  # sentinel: an age we could not compute, treated as failing

_rfa = {"last": 0.0, "primed": False, "why": "", "n": 0}


def _refocus_act_on():
    """Separate toggle from `refocus` on purpose. Wanting the alarm to grab the stick back
    and wanting a NAV click to do it are different appetites, and one pilot asked for the
    first without the second."""
    try:
        return bool(_srv["refocusact"])
    except Exception:
        return False


def _rf_activate(kind, age_s=None, explicit=False):
    """Refocus BECAUSE the pilot acted on the board. Returns True only when the foreground
    was observed to move. Records why it declined in `_rfa["why"]` — tests assert on that,
    and so can a puzzled pilot via the status line.

    ★ `explicit=True` is the BACK TO GAME button (b3.22), and it is gated differently on
    purpose. The other triggers are INFERENCE — we decide a NAV send probably means "put me
    back" — so they need the `refocusact` opt-in, the priming baseline and the burst
    cooldown to keep the inference from misfiring. A button press is not an inference; it is
    the pilot saying the thing out loud. So it skips all three:

      * `refocusact` — that toggle governs whether we GUESS. Refusing an explicit press
        because the guess-feature is off would be a dead control, which is the exact
        looks-installed-and-isn't shape this plugin has been bitten by three times.
      * priming — exists because a settings diff on the first poll might be history. A
        button press carries its own server timestamp, so freshness already proves intent.
      * cooldown — exists to collapse a burst of toggles. A human pressing a button twice
        means they wanted it twice, most likely because the first press did not work; a
        cooldown there is a dead button at the exact moment it matters.

    The freshness gate still applies, because replay is a property of the transport, not of
    how deliberate the pilot was."""
    _rfa["why"] = ""
    try:
        if not explicit and not _refocus_act_on():
            _rfa["why"] = "off"
            return False
        if os.name != "nt":
            _rfa["why"] = "not windows"
            return False
        if not explicit and not _rfa["primed"]:
            # First poll of the session: whatever we are seeing predates us.
            _rfa["why"] = "startup (baseline poll)"
            return False
        if age_s is not None:
            # age_s is None ONLY for structurally-fresh triggers (a settings change can only
            # be seen on the poll after it happened). Anything carrying an age must clear the
            # gate, and an age we could not compute counts as failing it.
            try:
                a = float(age_s)
            except (TypeError, ValueError):
                a = _RF_AGE_UNKNOWN
            if a != a or a == _RF_AGE_UNKNOWN:      # NaN, or no server clock to compare to
                _rfa["why"] = "age unknown (worker sent no clock)"
                return False
            if a > RF_ACT_MAX_AGE_S:
                _rfa["why"] = "stale (%.0fs old)" % a
                _set_status("refocus skipped - that action was %.0fs ago" % a)
                return False
        now = time.time()
        if not explicit and now - _rfa["last"] < RF_ACT_COOLDOWN_S:
            _rfa["why"] = "cooldown"
            return False
        _rfa["last"] = now
        _rfa["n"] += 1
        return _refocus_to_elite("board:" + str(kind))
    except Exception:
        _rfa["why"] = "error"
        return False


# --- b3.21: why the ALARM refocus has been failing, and the one lever that moves it ------
# b3.14 measured it and recorded the finding honestly: the alarm path "fails reliably",
# because Windows only lets SetForegroundWindow succeed for a process holding a foreground
# claim, and a journal-driven background thread holds none. The ladder's rungs 3 and 4 are
# workarounds for a rule we were never going to win against by trying harder.
#
# The rule has a documented dial: SPI_SETFOREGROUNDLOCKTIMEOUT — how long after the last
# user input Windows keeps refusing background foreground-changes. Set it to 0 and the
# refusal stops. This is what "always on top" utilities have used for twenty years.
#
# ⚠ IT IS A SYSTEM SETTING FOR THE WHOLE USER SESSION, not a plugin-local one. Any process
# on the machine may then steal focus. That is a real cost, it is the pilot's to accept,
# and so this is OPT-IN, off by default, EDMC-side (the machine it affects), saved and
# restored on plugin stop.
#
# ⚠⚠ UNVERIFIED ON WINDOWS AT TIME OF WRITING. Built and reasoned about in a Linux
# container; the Win32 behaviour has NOT been observed. `_fg_lock_report()` exists so the
# rig answers this with facts instead of me asserting it — read the status line after
# enabling, and the alarm's own refocus outcome is already announced by `_rf_won`.
SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000
SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001
SPIF_SENDCHANGE = 0x0002

_fglock = {"orig": None, "applied": False}


def _fg_lock_get():
    """Current foreground lock timeout in ms, or None if it cannot be read."""
    if os.name != "nt":
        return None
    try:
        import ctypes
        v = ctypes.c_uint(0)
        if ctypes.windll.user32.SystemParametersInfoW(
                SPI_GETFOREGROUNDLOCKTIMEOUT, 0, ctypes.byref(v), 0):
            return int(v.value)
    except Exception:
        pass
    return None


def _fg_lock_set(ms):
    """★ pvParam carries the VALUE here, not a pointer to it — SPI_SETFOREGROUNDLOCKTIMEOUT
    is one of the handful of SPI actions that work that way, and passing a byref like the
    GET does is the classic way to make this silently do nothing."""
    if os.name != "nt":
        return False
    try:
        import ctypes
        return bool(ctypes.windll.user32.SystemParametersInfoW(
            SPI_SETFOREGROUNDLOCKTIMEOUT, 0, ctypes.c_void_p(int(ms)), SPIF_SENDCHANGE))
    except Exception:
        return False


def _fg_lock_unlock_on():
    return _cfg_bool("blades_refocus_unlock", False)


def _fg_lock_apply():
    """Take the lock off if the pilot opted in; put it back if they opted out. Idempotent,
    so prefs_changed and plugin_start can both just call it."""
    if os.name != "nt":
        return
    try:
        want = _fg_lock_unlock_on()
        if want and not _fglock["applied"]:
            cur = _fg_lock_get()
            if cur is None:
                _set_status("refocus unlock: cannot read the Windows setting - not touching it")
                return
            _fglock["orig"] = cur
            if cur == 0:
                _fglock["applied"] = True        # already 0; nothing to do, nothing to restore
                _set_status("refocus unlock: already 0ms (nothing changed)")
                return
            if _fg_lock_set(0):
                _fglock["applied"] = True
                _set_status("refocus unlock ON (was %dms, now 0) - undo by unticking" % cur)
            else:
                _set_status("refocus unlock FAILED - Windows refused the change")
        elif not want and _fglock["applied"]:
            _fg_lock_restore()
    except Exception:
        pass


def _fg_lock_restore():
    """Put the pilot's setting back exactly as we found it. Called on opt-out and on stop —
    leaving a machine-wide setting changed after the plugin is gone would be rude."""
    try:
        if _fglock["applied"] and _fglock["orig"] is not None and _fglock["orig"] != 0:
            _fg_lock_set(int(_fglock["orig"]))
            _set_status("refocus unlock OFF (restored %dms)" % int(_fglock["orig"]))
        _fglock["applied"] = False
    except Exception:
        pass


def _fg_lock_report():
    """Ground truth for the rig, since this cannot be observed where it was written."""
    return {"os": os.name, "opt_in": bool(_fg_lock_unlock_on()),
            "current_ms": _fg_lock_get(), "orig_ms": _fglock["orig"],
            "applied": bool(_fglock["applied"])}


def _rf_loop(mods, vk):
    """Windows message pump for the global hotkey. RegisterHotKey with a NULL window posts
    WM_HOTKEY to THIS THREAD's queue, so the loop must live on the registering thread."""
    import ctypes
    from ctypes import wintypes
    u = ctypes.windll.user32
    HOTKEY_ID = 0xB1AD
    if not u.RegisterHotKey(None, HOTKEY_ID, mods, vk):
        # LOUD. A silently unregistered hotkey is a feature that looks installed and is not
        # — the exact failure shape this project keeps getting bitten by.
        _rf["state"] = "failed"
        _rf["why"] = "another application already owns " + _rf["spec"]
        _alert_raise("warn", "Refocus hotkey " + _rf["spec"] + " is taken by another app - pick another",
                     key="refocus-hotkey", cooldown=3600.0)
        _set_status("refocus hotkey UNAVAILABLE (" + _rf["spec"] + ")")
        return
    _rf["state"] = "on"
    _rf["why"] = ""
    # Announce SUCCESS too, not just failure. "It works" and "it never started" looked
    # identical from the outside in b3.11, which is exactly how the bug survived a test.
    # b3.19: that announcement now lives on the STATUS LINE ONLY. It used to also raise an
    # info alert, and that was wrong twice over. The `cooldown` could never suppress it —
    # `_alert_state["cool"]` is module memory and this fires at PLUGIN START, so every EDMC
    # restart reset the map and re-announced; five landed in 33 minutes on 2026-08-11. And
    # the strip shows only the newest 4, so a routine success was evicting real alerts: the
    # night the pirate alarm went live, the whole visible strip was this message. Refocus has
    # been reliable since b3.15, so the diagnostic no longer earns a slot in the lane.
    # The FAILURE path above still raises a warn — losing the success notice costs no signal.
    _set_status("refocus hotkey ARMED (" + _rf["spec"] + ")")
    msg = wintypes.MSG()
    try:
        while not _rf["stop"]:
            if u.PeekMessageW(ctypes.byref(msg), None, 0, 0, 1):
                if msg.message == 0x0312:      # WM_HOTKEY
                    _refocus_to_elite("hotkey")
            else:
                time.sleep(0.05)
    finally:
        try:
            u.UnregisterHotKey(None, HOTKEY_ID)
        except Exception:
            pass
        _rf["state"] = "off"


# b3.27 - _pa_test_fire() REMOVED (was here).
# It fired a synthetic pirate hail after a 10s delay so the alarm could be proven from a
# timer thread with NO foreground claim - a faithful reproduction of a real encounter,
# which is exactly why it was worth having during the shakedown. The alarm is proven now
# (b3.26 closed the last defect), so all that is left is a button that can set off a
# klaxon on a rig by accident.
#
# The trick worth remembering if it is ever needed again is THE DELAY: firing immediately
# would have carried the user-input foreground claim Windows looks for, and would have
# "proved" the alarm refocus works when it had only re-tested the hotkey path.


def _rf_sync():
    """Start or stop the hotkey thread to match the toggle. Safe to call repeatedly."""
    try:
        want = _refocus_on() and os.name == "nt"
        alive = _rf["thread"] is not None and _rf["thread"].is_alive()
        if want and not alive:
            spec = _RF_DEFAULT_HOTKEY
            try:
                spec = (_cfg.get_str("blades_refocus_hotkey") or _RF_DEFAULT_HOTKEY) if _cfg else _RF_DEFAULT_HOTKEY
            except Exception:
                pass
            mods, vk = _rf_parse_hotkey(spec)
            if not vk:
                _rf["state"] = "failed"
                _rf["why"] = "cannot parse hotkey '" + str(spec) + "'"
                _set_status("refocus hotkey unparseable: " + str(spec))
                return
            _rf["spec"], _rf["stop"] = spec, False
            _rf["thread"] = threading.Thread(target=_rf_loop, args=(mods, vk), daemon=True)
            _rf["thread"].start()
        elif not want and alive:
            _rf["stop"] = True
        elif _refocus_on() and os.name != "nt":
            _rf["state"] = "unsupported"
            _set_status("refocus: Windows only - toggle has no effect here")
    except Exception:
        pass


# --- b3.9: the pirate announces itself --------------------------------------
# `Scanned` carries ONLY timestamp/event/ScanType — it never names the scanner (verified
# against the journal spec 2026-08-10), so it cannot separate a pirate from a customs
# officer. b3.7 guessed "Cargo scan = pirate" and a security NPC proved it wrong.
#
# The identity does exist; it is just on a different event. NPC chatter arrives as
# ReceiveText with Channel="npc" and a ROLE-PREFIXED token in `Message`, and crucially the
# pirate HAILS YOU BEFORE IT INTERDICTS. That single fact reorders everything:
#
#   * The hail is EARLY  -> there is still time to boost, high-wake, or set up a submit-run.
#   * The hail is SPECIFIC -> it says who is talking, which is what `Scanned` could not.
#
# So the hail IS the alarm. The earlier design waited for interdiction / attack / hull
# damage to "confirm" a scan, but those all land AFTER the window in which anything can be
# done — a klaxon at that point is a narrator, not a warning. They are now a backstop only.
PIRATE_ESCALATE_S = 15.0        # backstop window: scan -> hostile act
PIRATE_NEAR_STATION_S = 300.0   # docking traffic keeps us in "authority country"
PIRATE_HAIL_S = 120.0           # how long a hostile hail keeps the encounter hot
PIRATE_ENCOUNTER_S = 120.0      # suppress a second klaxon for the same encounter
NOFIRE_TTL_S = 1800.0           # b3.17 backstop: the game does not reliably send `exited`

_PIRATE_SCANS = {
    "cargo": "PIRATE SCAN - your cargo hold is being read",
    "cabin": "CABIN SCAN - someone is hunting your passengers",
}

# Matched as case-insensitive SUBSTRINGS of the raw token, deliberately loose. The journal
# spec does not publish this vocabulary, and a hardcoded exact token that turns out wrong
# would fail SILENTLY — the single worst failure mode, and one this project has now hit
# three times. Broad match + capture log, then tighten from Adam's real journal.
_NPC_PIRATE_HINTS = ("pirate", "cargohunter", "cargo_hunter", "ambushedpilot", "assassin")
# Confirmed against a real capture log 2026-08-10: `$Police_ThankYouPassedStopAndSearch01;`
# proves the `$Role_` convention and that matching on the prefix works. Station and docking
# chatter is added because it is equally positive evidence of authority country.
_NPC_AUTH_HINTS = ("police", "security", "authority", "military", "customs",
                   "station", "docking", "starport")

# ★ The game TELLS you when you are in a no-fire zone. b3.9 asserted no such signal existed
# and built a timestamp proxy instead; the very first capture log contained both of these on
# the npc comms channel. Exact beats proxy — but the proxy is KEPT as a fallback, because a
# relog inside a zone never emits an `entered` and would otherwise read as open space.
_NPC_NOFIRE_IN = "nofirezone_entered"
_NPC_NOFIRE_OUT = "nofirezone_exited"

# SECOND NET, matched against Message_Localised (the words you actually read in comms).
# ⚠ PROVENANCE: supplied 2026-08-10 from an LLM's recollection of in-game dialogue, NOT
# from a captured journal. That is the same grade of evidence that produced the "Anatomy
# collection = VIRPIL product renders" dead end earlier the same day, so it is wired as a
# FALLBACK behind the token match and never as the sole trigger. Phrases are chosen to be
# unambiguously predatory — "cargo" alone would also match a customs officer. The capture
# log is what replaces this with fact on first flight.
_NPC_PIRATE_PHRASES = (
    "take it by force", "pull over", "don't try to run", "tasty cargo",
    "big haul", "all that haul", "you've got what i want", "i knew i'd find you",
    "what's in your cargo hold", "that's the ship i'm after",
)

_pa_st = {"near_until": 0.0, "pend_until": 0.0, "pend_msg": "", "legal": "",
          "flags_prev": 0, "hail_until": 0.0, "alarmed_until": 0.0, "nofire_until": 0.0}
_pa_seen = set()


def _pa_flags():
    f = _hk.get("flags")
    return f if isinstance(f, int) else 0


def _pa_authority_country():
    """LOCATION GATE. Authority scans cluster where authority is; pirates scan you in open
    space. Status.json has no 'no-fire zone' flag, so this is a PROXY: docked, landed, or
    recently in docking traffic (or a police voice heard nearby)."""
    if time.time() < _pa_st.get("nofire_until", 0.0):  # exact, announced by the game
        return True
    f = _pa_flags()
    if (f & 0x1) or (f & 0x2):          # Docked / Landed
        return True
    return time.time() < _pa_st.get("near_until", 0.0)


def _pa_worth_taking():
    """CARGO-VALUE GATE. A hold scan only threatens you if the hold holds something — or if
    you are already wanted. Unknown cargo FAILS OPEN."""
    try:
        if str(_pa_st.get("legal") or "").strip().lower() not in ("", "clean"):
            return True
        used = _LO.get("cargoUsed")
        if used is None:
            return True
        return float(used) > 0
    except Exception:
        return True


def _pa_alarm(msg, reason=""):
    """The real thing: critical + klaxon on the rig + the page flash on the board.

    b3.14: the refocus is attempted BEFORE the alert is raised, so that when it fails the
    alert can carry the remedy. Rather than silently trying and silently losing, the
    message tells the pilot which key takes the stick back — on the very flash they are
    already looking at.

    ⚠ b3.26 corrects b3.14's premise: this path does NOT "fail reliably". Since b3.15 the
    refocus ladder usually WINS on Adam's rig (rung 1 direct loses, rung 2 alt-tap takes
    it, 5/5 measured), so the hint is a fallback for a case b3.15 mostly closed — another
    pilot's Windows, or fullscreen-exclusive. That is exactly why the truncation bug below
    survived eleven builds unseen: the path that carried it rarely ran."""
    hint = ""
    if _refocus_on():
        try:
            # b3.26 — gate on the FOREGROUND REFUSAL specifically, not on "not True".
            # _refocus_to_elite also returns False when Elite is not running at all (the
            # "window not found" branch), and there the key we would be telling the pilot
            # to press is exactly as dead as the automation was — the hotkey calls the
            # SAME function and lands in the SAME branch. Only "failed" means Windows
            # refused a game that IS there, which is the one case a human press can still
            # win, because the keypress carries the foreground claim a journal-driven
            # background thread has never had.
            if (not _refocus_to_elite("pirate alarm")
                    and _rf.get("last") == "failed"
                    and _rf.get("state") == "on"):
                hint = " - press " + str(_rf.get("spec") or "").upper() + " for control"
        except Exception:
            pass                                  # refocus must NEVER take the alarm down

    # ★ b3.26 — RESERVE THE REMEDY'S ROOM FIRST, spend what is left on the pirate.
    # The old order built `msg + reason[:60]`, appended the hint, and let _alert_raise cut
    # the whole thing at _ALERT_MSG_MAX — so the cap ate the remedy from the RIGHT and the
    # pilot read "... - press " with no key name. A failed automation became half a
    # preposition. Whether the alarm was actionable depended on how talkative the pirate
    # was: replayed through this matcher over Adam's 654-journal NPC vocabulary, only
    # 36/159 hails delivered the whole remedy, 48 named a fragment of the key and 75 lost
    # the promise entirely. The pirate's chatter is the part that can be cut without cost;
    # the key name is not. A hint that will not fit WHOLE is dropped whole — a half-named
    # key is worse than no promise, because the pilot reaches for a key that isn't there.
    # THE CAP IS NOT THE VILLAIN AND DOES NOT MOVE: alerts ride the heartbeat as a
    # urlencoded &al= param, so 90 is protecting the URL. This is the order of sacrifice,
    # not the budget — the longest alert is still exactly 90 chars.
    if len(msg) + len(hint) > _ALERT_MSG_MAX:
        hint = ""
    room = _ALERT_MSG_MAX - len(msg) - len(hint) - 3        # 3 = the " - " separator
    txt = (msg + " - " + str(reason)[:room]) if (reason and room > 0) else msg
    if _alert_raise("critical", txt + hint, key="pirate-alarm",
                    cooldown=PIRATE_COOLDOWN_S, blare=True):
        _pa_st["alarmed_until"] = time.time() + PIRATE_ENCOUNTER_S
        return True
    return False


def _pa_capture(tok, loc):
    """CAPTURE MODE. Record every distinct NPC token this game actually emits, so the match
    above can be tightened from real data instead of from someone's memory. Bounded, append
    only, best-effort — it must never be able to break the alarm it is helping to build."""
    try:
        if not tok or tok in _pa_seen or len(_pa_seen) >= 200:
            return
        _pa_seen.add(tok)
        d = _state.get("dir")
        if not d:
            return
        with open(os.path.join(d, "npc-tokens.log"), "a", encoding="utf-8") as fh:
            fh.write(str(tok) + "\t" + str(loc or "") + "\n")
    except Exception:
        pass


def _pa_npc_text(entry, capture=True):
    """★ THE EARLY WARNING. A hostile NPC opening its mouth is the first and best signal."""
    if not _pirate_on():
        return
    if str(entry.get("Channel") or "").strip().lower() != "npc":
        return
    tok = str(entry.get("Message") or "")
    loc = str(entry.get("Message_Localised") or "")
    if capture:
        _pa_capture(tok, loc)
    low = tok.lower()
    # Curly apostrophes are common in localised strings and would break a naive match.
    low_loc = loc.lower().replace("\u2019", "'")

    # Exact no-fire-zone state, straight from the game. Checked BEFORE the role hints
    # because these tokens also contain "station" and would otherwise stop at the auth
    # branch without ever updating the flag.
    if _NPC_NOFIRE_IN in low:
        _pa_st["nofire_until"] = time.time() + NOFIRE_TTL_S
        return
    if _NPC_NOFIRE_OUT in low:
        _pa_st["nofire_until"] = 0.0
        return

    # ★ b3.17 — the SPEAKER wins over the TOPIC. `$Pirate_OnAuthorityDetection*` contains both
    # "pirate" and "authority", and because the auth branch ran first it returned early: a
    # pirate reacting to the cops read AS the cops and bought itself 300s of quiet country.
    # The $Role_ prefix convention held across all 36,610 replayed events, so a token that
    # STARTS with $pirate is a pirate speaking. Deliberately narrower than swapping the two
    # list checks, which would also let police chatter ABOUT pirates raise the alarm.
    if low.startswith("$pirate"):
        _pa_st["hail_until"] = time.time() + PIRATE_HAIL_S
        _pa_alarm("PIRATE INBOUND - hostile hail", loc[:60])
        return

    if any(h in low for h in _NPC_AUTH_HINTS):
        # A police voice is positive evidence of authority country, wherever we are.
        _pa_st["near_until"] = max(_pa_st.get("near_until", 0.0),
                                   time.time() + PIRATE_NEAR_STATION_S)
        return
    by_token = any(h in low for h in _NPC_PIRATE_HINTS)
    by_words = any(ph in low_loc for ph in _NPC_PIRATE_PHRASES)
    if by_token or by_words:
        _pa_st["hail_until"] = time.time() + PIRATE_HAIL_S
        # Record WHICH net caught it, so the capture log can prove whether the token match
        # is doing the work or the unverified phrase list is carrying the feature.
        _pa_alarm("PIRATE INBOUND - hostile hail" + ("" if by_token else " (phrase)"), loc[:60])


def _pa_scanned(entry):
    if not _pirate_on():
        return
    kind = str(entry.get("ScanType") or "").strip().lower()
    if kind == "crime":
        _alert_raise("info", "Authority scan - routine crime check",
                     key="crime-scan", cooldown=PIRATE_COOLDOWN_S)
        return
    msg = _PIRATE_SCANS.get(kind)
    if not msg:
        return

    # A pirate already announced itself, so we have already shouted. The scan only
    # corroborates it; logging beats a second klaxon.
    if time.time() < _pa_st.get("hail_until", 0.0):
        _alert_raise("info", "Scan follows a pirate hail - already alarmed",
                     key="pirate-scan", cooldown=PIRATE_COOLDOWN_S)
        return

    laden = _pa_worth_taking()
    safe = _pa_authority_country()
    where = "station space" if safe else "open space"

    # ★ b3.20 — MEASURED 2026-08-12, and it overturned the previous rule.
    # Five real Cargo scans in one night: FOUR police, ONE pirate. The only thing that
    # separated them was TIMING. The pirate announced itself ~10s BEFORE the scan
    # ($Pirate_OnStartScanCargo09 -> "The scan will soon be over."); the police only ever
    # spoke at +0s, AFTER it completed. Neither location nor cargo discriminated at all —
    # all three false warns that night were laden-in-station-space, which is precisely what
    # the old rule treated as suspicious. It was 0 for 3.
    #
    # So `Scanned` no longer raises a warning on its own. It is a CONFIRMATION, not a
    # warning: it fires as the scan completes, which is already too late to act on. The
    # hail path above is the only genuine early warning — and it went 1 for 1 on real data.
    #
    # QUIETER, NOT BLINDER: the escalation window is still armed below, so a pirate who
    # scans without speaking and then shoots still gets the klaxon via _pa_confirm.
    # The "no hail first" wording is deliberate — it makes every unexplained scan countable
    # in the log, which is how the true miss rate gets measured instead of estimated.
    # Say "cargo scan", NOT "PIRATE SCAN": we have just concluded it is probably authority,
    # and a line that shouts PIRATE while filing itself as info reads as a bug. `msg` keeps
    # the alarming wording for `pend_msg` below, which is what the klaxon says IF this
    # escalates. (_ALERT_MSG_MAX is 90 — the earlier wording was 100 and shipped truncated
    # mid-word. Anything built by concatenation here needs counting, not eyeballing.)
    _alert_raise("info", kind.capitalize() + " scan - no hail first, likely authority (" +
                 ("laden" if laden else "empty hold") + ", " + where + ")",
                 key="pirate-scan", cooldown=PIRATE_COOLDOWN_S)
    _pa_st["pend_until"] = time.time() + PIRATE_ESCALATE_S
    _pa_st["pend_msg"] = msg


def _pa_confirm(reason):
    """BACKSTOP ONLY. Interdiction, attack and hull damage all arrive AFTER the moment
    anything could be done about them, so they are not the alarm — they only catch the case
    where an un-hailed scan turned out to be real and nothing else fired."""
    try:
        if not _pirate_on():
            return False
        now = time.time()
        if now < _pa_st.get("alarmed_until", 0.0):
            return False                      # already shouted for this encounter
        if now >= _pa_st.get("pend_until", 0.0):
            return False
        _pa_st["pend_until"] = 0.0
        return _pa_alarm("THREAT CONFIRMED", reason)
    except Exception:
        return False


def _pa_journal_hostile(ev, entry):
    if ev == "Interdicted":
        _pa_confirm("interdicted by " + str(entry.get("Interdictor") or "unknown")[:40])
    elif ev == "UnderAttack":
        if str(entry.get("Target") or "").strip().lower() in ("", "you", "mothership"):
            _pa_confirm("under attack")
    elif ev == "HullDamage":
        if entry.get("PlayerPilot", True):
            _pa_confirm("taking hull damage")
    elif ev == "ShieldState":
        if entry.get("ShieldsUp") is False:
            _pa_confirm("shields down")


_fuel = {"main": None, "cap": None, "used": None}


def _fuel_check():
    # Fuel-low now raises a WARN on the shared alerts lane (which also writes the EDMC status
    # line) instead of only writing status — so it reaches the dashboard strip like any other
    # alert. Cooled hard: one warning per 5 minutes, not one per FSD target change.
    try:
        m = _fuel.get("main")
        if not m:
            return
        u = _fuel.get("used")
        if u and u > 0:
            jumps = m / u
            if jumps < 2.0:
                _alert_raise("warn", "Fuel low - ~%.1f jump(s) left, scoop soon" % jumps,
                             key="fuel-low", cooldown=300.0)
                return
        cap = _fuel.get("cap")
        if cap and m < cap * 0.2:
            _alert_raise("warn", "Fuel low - %d%% tank" % int(100 * m / cap),
                         key="fuel-low", cooldown=300.0)
    except Exception:
        pass


# --- EDMC lifecycle ---------------------------------------------------------
def plugin_start3(plugin_dir):
    _state["dir"] = plugin_dir
    _load_seen()
    _load_srv()
    # If a staged update has now become the running version, clear its marker.
    try:
        _pend = _read_pending().get("version")
        if _pend and _ver_tuple(PLUGIN_VERSION) >= _ver_tuple(_pend):
            _clear_pending()
    except Exception:
        pass
    _start_nav_poll()
    # b3.13: ARM THE REFOCUS HOTKEY AT STARTUP.
    # b3.11 only ever called this from _apply_srv, gated on the value CHANGING. Flipping the
    # toggle armed the hotkey; every EDMC restart after that loaded refocus=true from disk,
    # observed no change, and quietly never registered it — and because _rf_loop never ran,
    # nothing reported the failure. A feature that looks installed and is not.
    try:
        _rf_sync()
    except Exception:
        pass
    # Same lesson as the hotkey above, applied to the lock: an opt-in that only takes effect
    # when the checkbox CHANGES is off again after every restart, silently.
    try:
        _fg_lock_apply()
    except Exception:
        pass
    # b3.24 — THE GATE IS SPLIT. This scan is READ-AND-REPORT ONLY: it reads journals the
    # pilot already wrote and tells the ledger which systems they already claimed and which
    # carrier they already own. It creates NOTHING. Auto-CREATE — writing new builds into
    # Raven on the pilot's behalf — is a different act with a different risk, and keeps its
    # own gate down in the docked/market path.
    # Until now both hid behind `_autocreate()`, which defaults to False, so for a default
    # pilot the launch scan never ran at all — while three places on the site said it did.
    # Conflating "report what I did" with "act for me" is what made that invisible.
    threading.Thread(target=_run_backfill, daemon=True).start()
    if _honk_on():
        try:
            _hk_resolve()
        except Exception:
            pass
    if _galaxymap_on():
        try:
            _gm_resolve()
        except Exception:
            pass
    return PLUGIN_NAME


def plugin_app(parent):
    # b3.27 — BACK TO A BARE LABEL. The Frame existed only to seat the "TEST ALARM (10s)"
    # button beside the status line, and that button was shakedown scaffolding: it fired a
    # synthetic pirate hail from a timer thread so the alarm could be proven without waiting
    # for a real pirate. The alarm is proven, so the button is now just a way to set off a
    # klaxon by accident on somebody else's rig.
    try:
        import tkinter as tk
        lbl = tk.Label(parent, text="Blades: idle (v" + PLUGIN_VERSION + ")")
        _state["status"] = lbl
        # plugin_start3 runs BEFORE plugin_app, so anything _set_status said during startup
        # went to a label that did not exist yet. Re-report ONLY THE FAILURE now that there
        # is somewhere to report to.
        # ⚠ The success case ("hotkey ARMED") is deliberately NOT re-reported any more: it was
        # there to prove arming worked during the b3.13–b3.25 shakedown, and a status line
        # that announces routine success trains you to ignore it. A hotkey that could not arm
        # is still news — that one stays, and the "taken by another app" warn alert raised at
        # arming time is independent of this and also untouched.
        try:
            if _rf.get("state") in ("failed", "unsupported"):
                _set_status("refocus hotkey NOT armed: " + str(_rf.get("why") or _rf.get("state")))
        except Exception:
            pass
        return lbl
    except Exception:
        return None


def dashboard_entry(cmdr, is_beta, entry):
    # EDMC hands us Status.json changes; track flags (honk gate) + fuel (fuel check).
    try:
        fl = entry.get("Flags")
        if isinstance(fl, int):
            _hk["flags"] = fl
            # b3.9: RISING EDGE only. IsInDanger sits set for the whole fight, so testing the
            # bit alone would re-confirm every status tick; only the transition is news.
            _prev = _pa_st.get("flags_prev", 0)
            if (fl & 0x800000) and not (_prev & 0x800000):
                _pa_confirm("being interdicted")
            elif (fl & 0x400000) and not (_prev & 0x400000):
                _pa_confirm("in danger")
            _pa_st["flags_prev"] = fl
        _ls = entry.get("LegalState")
        if _ls is not None:
            _pa_st["legal"] = str(_ls)
        fu = entry.get("Fuel")
        if isinstance(fu, dict) and fu.get("FuelMain") is not None:
            _fuel["main"] = fu.get("FuelMain")
    except Exception:
        pass


# Settings tab: enable auto-create, set the fallback architect, and the grace period.
def plugin_prefs(parent, cmdr, is_beta):
    try:
        import tkinter as tk
        try:
            import myNotebook as nb
        except Exception:
            nb = None
        # Resolve widgets defensively: recent EDMC (myNotebook.py) renamed
        # Entry -> EntryMenu and may rename others, so fall back gracefully
        # instead of letting an AttributeError kill the whole settings tab.
        F = getattr(nb, "Frame", tk.Frame) if nb else tk.Frame
        L = getattr(nb, "Label", tk.Label) if nb else tk.Label
        C = getattr(nb, "Checkbutton", tk.Checkbutton) if nb else tk.Checkbutton
        E = (getattr(nb, "Entry", None) or getattr(nb, "EntryMenu", tk.Entry)) if nb else tk.Entry

        frame = F(parent)
        _prefs["autocreate"] = tk.IntVar(value=1 if _autocreate() else 0)
        _prefs["architect"] = tk.StringVar(value=_architect())
        _prefs["grace"] = tk.StringVar(value=str(_grace_seconds() // 60))

        r = 0
        L(frame, text="Onyx Blades — Build Registrar").grid(row=r, column=0, columnspan=2, sticky="w", padx=8, pady=(8, 2)); r += 1
        C(frame, text="Auto-create a build in Raven when none exists (safeguarded)",
          variable=_prefs["autocreate"]).grid(row=r, column=0, columnspan=2, sticky="w", padx=8); r += 1
        L(frame, text="Fallback architect (used when it can't be auto-detected):").grid(row=r, column=0, sticky="w", padx=8, pady=(6, 0)); r += 1
        E(frame, textvariable=_prefs["architect"], width=24).grid(row=r, column=0, sticky="w", padx=8); r += 1
        L(frame, text="Grace period before auto-create (minutes):").grid(row=r, column=0, sticky="w", padx=8, pady=(6, 0)); r += 1
        E(frame, textvariable=_prefs["grace"], width=6).grid(row=r, column=0, sticky="w", padx=8, pady=(0, 8)); r += 1
        _prefs["honk"] = tk.IntVar(value=1 if _honk_on() else 0)
        C(frame, text="Honk on arrival - auto-fire the Discovery Scanner when you jump (BladeRelay)",
          variable=_prefs["honk"]).grid(row=r, column=0, columnspan=2, sticky="w", padx=8, pady=(8, 0)); r += 1
        L(frame, text="reads your scanner fire key from your bindings - Windows only").grid(row=r, column=0, columnspan=2, sticky="w", padx=8, pady=(0, 8)); r += 1
        # Machine-local on purpose: this changes a WINDOWS setting for the whole user
        # session, so it is consented on the machine it affects, not from the board.
        _prefs["rfunlock"] = tk.IntVar(value=1 if _fg_lock_unlock_on() else 0)
        C(frame, text="Let the pirate alarm take focus (changes a Windows setting)",
          variable=_prefs["rfunlock"]).grid(row=r, column=0, columnspan=2, sticky="w", padx=8, pady=(8, 0)); r += 1
        L(frame, text="sets the foreground lock timeout to 0 so a background alarm CAN pull you back to Elite.").grid(row=r, column=0, columnspan=2, sticky="w", padx=8); r += 1
        L(frame, text="side effect - any app on this PC may then steal focus. Restored when you untick or close EDMC.").grid(row=r, column=0, columnspan=2, sticky="w", padx=8, pady=(0, 8)); r += 1
        return frame
    except Exception:
        return None


def prefs_changed(cmdr, is_beta):
    if _cfg is None:
        return
    try:
        if "autocreate" in _prefs:
            _cfg.set("blades_autocreate", 1 if _prefs["autocreate"].get() else 0)
        if "architect" in _prefs:
            _cfg.set("blades_architect", (_prefs["architect"].get() or DEFAULT_ARCHITECT).strip())
        if "grace" in _prefs:
            try:
                g = int(_prefs["grace"].get())
            except Exception:
                g = DEFAULT_GRACE_MIN
            _cfg.set("blades_grace_min", max(0, g))
        if "honk" in _prefs:
            _cfg.set("blades_honk", 1 if _prefs["honk"].get() else 0)
            if _prefs["honk"].get():
                try:
                    _hk_resolve()
                except Exception:
                    pass
        if "rfunlock" in _prefs:
            _cfg.set("blades_refocus_unlock", 1 if _prefs["rfunlock"].get() else 0)
            try:
                _fg_lock_apply()      # applies OR restores — it reads the setting itself
            except Exception:
                pass
        # Saving the tab with auto-create ON = "report my claims now": clear the
        # one-time marker and re-scan immediately, no EDMC restart needed.
        if _prefs.get("autocreate") and _prefs["autocreate"].get():
            try:
                os.remove(_backfill_path())
            except OSError:
                pass
            threading.Thread(target=lambda: _run_backfill(0), daemon=True).start()
    except Exception:
        pass


def plugin_stop():
    """b3.21. EDMC calls this on shutdown. The ONLY thing that must happen here is putting
    the pilot's Windows foreground-lock setting back — we changed a machine-wide setting on
    their behalf and leaving it changed after we are gone would be rude, and worse, invisible.
    Everything else in this plugin is daemon threads and dies with the process."""
    try:
        _fg_lock_restore()
    except Exception:
        pass


_prefs = {}


# --- system architect lookup ------------------------------------------------

def _raven_system_architect(system_address):
    """Query Raven for ACTIVE builds in this system; return the architectName
    from the first sibling that has a real (non-fallback) architect, or None."""
    try:
        fallback = _architect()
        url = RAVEN_BASE + "/api/system/" + str(system_address)
        req = urllib.request.Request(url, headers={
            "User-Agent": BROWSER_UA, "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
        builds = json.loads(raw)
        if isinstance(builds, list):
            for b in builds:
                arch = b.get("architectName") or ""
                if arch and arch != fallback:
                    return arch
    except Exception:
        pass
    return None


def _board_system_architect(system_name):
    """Ask the board for the architect of a system by checking sibling builds
    in KV (covers completed builds that Raven no longer exposes). Requires the
    /ingest/architect endpoint — gracefully returns None if it doesn't exist yet."""
    if not system_name:
        return None
    try:
        url = INGEST_URL.rsplit("/", 1)[0] + "/architect?system=" + urllib.request.quote(system_name)
        req = urllib.request.Request(url, headers={
            "User-Agent": BROWSER_UA, "Accept": "application/json",
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            body = json.loads(resp.read().decode("utf-8", errors="replace"))
        return body.get("architect") or None
    except Exception:
        return None


# --- direct Raven create (bypasses Cloudflare function timeout) -------------

def _raven_create(market_id, system_address, build_name, architect_name, system_name="", body_name="", body_num=None, commodities=None):
    """PUT directly to RavenColonial to create a build. Retries up to 3 times
    with backoff to handle Azure cold starts. Returns the parsed JSON response
    on success, or None on failure (status line + last_error.json updated)."""
    raven_url = RAVEN_BASE + "/api/project"
    payload = {
        "marketId": market_id,
        "systemAddress": system_address,
        "buildName": build_name,
        "architectName": architect_name,
        "systemName": system_name,
        "buildType": "consus",  # Raven's type for colonisation construction sites
    }
    if commodities:
        payload["commodities"] = commodities
    if body_name:
        payload["bodyName"] = body_name
    if body_num is not None:
        payload["bodyNum"] = body_num

    data = json.dumps(payload).encode("utf-8")
    last_err = None
    for attempt in range(3):
        if attempt > 0:
            wait = 10 * attempt  # 10s, 20s backoff
            _set_status("Raven cold — retry %d in %ds…" % (attempt + 1, wait))
            time.sleep(wait)
        try:
            req = urllib.request.Request(
                raven_url, data=data,
                headers={
                    "Content-Type": "application/json",
                    "User-Agent": BROWSER_UA,
                    "Accept": "application/json",
                }, method="PUT",
            )
            with urllib.request.urlopen(req, timeout=60) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            return json.loads(raw)
        except urllib.error.HTTPError as he:
            raw = ""
            try:
                raw = he.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            last_err = ("raven_http_%d" % he.code, raw)
        except Exception as e:
            last_err = ("raven_exception", str(e))
    # All retries exhausted
    if last_err:
        _write_last_error(0, last_err[1], {"raven_direct": True, "marketId": market_id,
                                            "systemAddress": system_address, "reason": last_err[0]})
        _set_status("Raven create failed (%s) — logged" % last_err[0])
    return None


# --- ingest -----------------------------------------------------------------
LAST_ERROR_FILE = "last_error.json"


def _write_last_error(status, raw, payload):
    """Persist the full failure (status + raw body + request summary) so a blind
    502 always leaves a readable trail in the plugin folder. This is the thing
    that turns 'ingest error 502' from a dead end into a diagnosable cause."""
    try:
        summary = {k: payload.get(k) for k in
                   ("marketId", "systemAddress", "cmdr", "create", "systemName")}
        with open(os.path.join(_state["dir"], LAST_ERROR_FILE), "w", encoding="utf-8") as f:
            json.dump({"ts": int(time.time()), "http_status": status,
                       "raw_body": (raw or "")[:2000], "request": summary}, f, indent=1)
    except Exception:
        pass


def _post(payload, market_id, was_create):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        INGEST_URL, data=data,
        headers={
            "Content-Type": "application/json",
            # A normal browser UA — Cloudflare's Browser Integrity Check blocks
            # the default "Python-urllib/..." UA with a 403.
            "User-Agent": BROWSER_UA,
            "Accept": "application/json",
        }, method="POST",
    )
    try:
        # Timeout sits ABOVE the server's overall deadline (22s) so we actually
        # receive its structured 502 instead of giving up first and blaming "offline".
        try:
            with urllib.request.urlopen(req, timeout=25) as resp:
                raw = resp.read().decode("utf-8", errors="replace")
            body = json.loads(raw)
        except urllib.error.HTTPError as he:
            # Read the raw error body (JSON or not) — never discard it.
            raw = ""
            try:
                raw = he.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            detail = {}
            try:
                detail = json.loads(raw)
            except Exception:
                pass
            if he.code == 404:
                if was_create:
                    # Grace expired, no build in Raven — create directly (bypasses CF timeout).
                    _set_status("creating in Raven (direct)…")
                    sys_name = payload.get("systemName") or ""
                    _mid_cr = payload.get("marketId")
                    _site_nm = _SITE_NAMES.get(str(_mid_cr)) if _mid_cr is not None else None
                    build_name = _site_nm or ((sys_name + " Construction Site") if sys_name else "Construction Site")
                    # Architect: claims-first, then Raven siblings, then board siblings, then fallback.
                    sa = payload.get("systemAddress")
                    sys_name_for_lookup = sys_name
                    architect = _state["claims"].get(sa)
                    if not architect:
                        _set_status("checking Raven for system architect…")
                        architect = _raven_system_architect(sa)
                    if not architect:
                        _set_status("checking board for system architect…")
                        architect = _board_system_architect(sys_name_for_lookup)
                    if not architect:
                        architect = _architect()
                    result = _raven_create(
                        payload["marketId"], payload["systemAddress"], build_name,
                        architect,
                        system_name=sys_name,
                        body_name=payload.get("bodyName", ""),
                        body_num=payload.get("bodyNum"),
                        commodities=_state["commodities"].get(payload["marketId"]),
                    )
                    if result:
                        # Raven created the build — now register it on the board.
                        _set_status("created in Raven — registering on board…")
                        payload["create"] = False
                        _post(payload, market_id, False)
                    else:
                        # _raven_create already updated status + last_error.json
                        _state["pending"][market_id] = time.time()  # re-arm grace
                    return
                # No build yet, not creating — keep waiting.
                _report_waiting(market_id)
                return
            # Any other non-2xx is a real failure: persist the full body so we're never blind.
            _write_last_error(he.code, raw, payload)
            reason = detail.get("reason") if isinstance(detail, dict) else None
            err = detail.get("error") if isinstance(detail, dict) else None
            if he.code == 401:
                _set_status("auth error (bad key)")
            elif reason == "raven_auth":
                _set_status("auto-create needs Raven login — create it in SrvSurvey")
            elif reason:
                # deadline / handler_error / raven_timeout / raven_400 / conflict / ...
                _set_status("auto-create failed (" + str(reason) + ") — logged, will retry")
                if was_create:
                    _state["pending"][market_id] = time.time()  # re-arm grace; don't hammer Raven
            elif err:
                _set_status(str(err) + " " + str(he.code) + " — logged")
                if was_create:
                    _state["pending"][market_id] = time.time()
            else:
                # Bare / non-JSON gateway error (e.g. a raw Cloudflare 502). We captured the body.
                _set_status("server error " + str(he.code) + " (no reason — see last_error.json)")
                if was_create:
                    _state["pending"][market_id] = time.time()
            return
        if body.get("ok"):
            _state["seen"].add(market_id)
            _state["pending"].pop(market_id, None)
            _save_seen()
            if body.get("created"):
                who = body.get("architect") or "?"
                tag = {"claim": " (claimed ✓)", "raven-siblings": " (from Raven)",
                       "fallback": " (fallback — fix later)"}.get(body.get("architectSource") or "", "")
                _set_status("created " + (body.get("name") or body.get("id", "build")) + " · architect " + who + tag)
            elif body.get("added"):
                _set_status("registered " + (body.get("name") or body.get("id", "build")))
            else:
                _set_status("already listed")
        else:
            _write_last_error(200, raw, payload)
            _set_status("skip (" + str(body.get("error", "?")) + ") — logged")
    except Exception as e:
        _write_last_error(0, "client exception: " + str(e), payload)
        _set_status("post failed (offline?) — logged")


def _report_waiting(market_id):
    if _autocreate():
        first = _state["pending"].get(market_id)
        if first is None:
            _set_status("waiting — no build in Raven yet")
            return
        remaining = int(_grace_seconds() - (time.time() - first))
        if remaining > 0:
            m, s = divmod(remaining, 60)
            _set_status("waiting — auto-create in %dm%02ds" % (m, s))
        else:
            _set_status("waiting — arming auto-create…")
    else:
        _set_status("waiting — create the build in Raven first")


# Facility names for colonisation construction sites, keyed by MarketID (str). The Docked /
# Docking* events carry a human name ("Planetary/Orbital Construction Site: <name>"); the
# ColonisationConstructionDepot event that triggers auto-create does NOT. We stash the name
# here on docking so auto-create can label the build properly instead of a generic name.
_SITE_NAMES = {}


def _clean_site_name(station_name):
    """Strip ED's 'Planetary/Orbital Construction Site: ' prefix, return just the facility name.
    Generic: works for any '<X> Construction Site: <name>'. Falls back to the raw StationName."""
    s = (station_name or "").strip()
    if not s:
        return ""
    marker = "construction site:"
    i = s.lower().find(marker)
    if i >= 0:
        return s[i + len(marker):].strip()
    return s


def journal_entry(cmdr, is_beta, system, station, entry, state):
    ev = entry.get("event")

    if cmdr:
        _nav["cmdr"] = cmdr

    # ─── b3.18 SEED FROM EDMC's STATE ────────────────────────────────────────────────────
    # Ship / cargo / fuel-capacity only ever arrived on `Loadout`, and EDMC does NOT re-emit
    # Loadout to a plugin loaded mid-session (measured on the rig: 0 Loadout events in the 57
    # following a restart). So restarting EDMC while Elite kept running left those tiles
    # dashed FOREVER — hauling could not heal it, because Cargo alone carries neither the ship
    # nor the fuel capacity. Only a game relog or an outfitting change did.
    #
    # EDMC hands every plugin a reconstructed `state` dict that survives exactly this case:
    # 42 of 60 keys were already populated on the FIRST journal_entry after a mid-session
    # restart (richer than a cold start's 13), and ship/cargoCap/fuelCap stayed stable across
    # all 57 subsequent events. Seed from it, once, when we have nothing better.
    #
    # ⚠ SHAPES ARE MEASURED, NOT GUESSED — two plausible guesses were wrong and would have
    # shipped a dict into an int field:
    #   state["Cargo"]         -> dict {commodity: count}, NOT a tonnage. Sum the values.
    #   state["FuelCapacity"]  -> dict {"Main": .., "Reserve": ..}, NOT a float. There is NO
    #                             "FuelLevel" key at all (harmless — live fuel comes from
    #                             Status.json; only capacity was ever missing).
    # isinstance guards throughout: if EDMC ever flattens one of these, a bare .get() would
    # raise AttributeError *inside* journal_entry.
    if isinstance(state, dict):
        try:
            if not _LO.get("ship"):
                _sd_ship = state.get("ShipType")
                if _sd_ship:
                    _LO["ship"] = str(_sd_ship)
                    _LO["shipName"] = str(state.get("ShipName") or "")
                    _sd_cap = state.get("CargoCapacity")
                    if isinstance(_sd_cap, int):
                        _LO["cargoCap"] = _sd_cap
                    # CargoJSON["Count"] is the GAME's own total — authoritative rather than
                    # derived — but it is None on an empty hold, so summing Cargo is the only
                    # branch that yields a correct 0. Both are load-bearing; neither is padding.
                    _sd_cj = state.get("CargoJSON")
                    if isinstance(_sd_cj, dict) and isinstance(_sd_cj.get("Count"), int):
                        _LO["cargoUsed"] = _sd_cj["Count"]
                    else:
                        _sd_cargo = state.get("Cargo")
                        if isinstance(_sd_cargo, dict):
                            _LO["cargoUsed"] = sum(v for v in _sd_cargo.values() if isinstance(v, int))
            if _fuel.get("cap") is None:
                _sd_fc = state.get("FuelCapacity")
                if isinstance(_sd_fc, dict) and _sd_fc.get("Main"):
                    _fuel["cap"] = _sd_fc.get("Main")
            # `sys` had the SAME restart bug with a different symptom. It is NOT Status.json
            # backed — Status.json carries no star-system name at all — it reads a module-level
            # cache fed by journal events, so a restart left it empty and the board kept
            # painting whatever it last knew. Seed it, and the system address with it.
            if not _state.get("system"):
                _sd_sys = state.get("SystemName")
                if _sd_sys:
                    _state["system"] = str(_sd_sys)
            if _state.get("sa") is None and state.get("SystemAddress"):
                _state["sa"] = state.get("SystemAddress")
        except Exception:
            pass   # seeding is best-effort; never break the journal callback over it

    # honk-on-arrival (BladeRelay): fire the Discovery Scanner on a real jump.
    if ev == "FSDJump":
        try:
            _hk_arrival(entry.get("SystemAddress"))
        except Exception:
            pass
    elif ev == "FSSDiscoveryScan":
        try:
            _hksa = entry.get("SystemAddress")
            if _hksa is not None:
                if _hksa in _hk["honked"]:
                    _set_status("honk verified")
                _hk["honked"].add(_hksa)
        except Exception:
            pass

    # fuel safety check (BladeRelay assist): track tank + per-jump cost, warn on a target
    if ev == "Loadout":
        try:
            _fc = entry.get("FuelCapacity")
            if isinstance(_fc, dict) and _fc.get("Main"):
                _fuel["cap"] = _fc.get("Main")
        except Exception:
            pass
    if ev == "FSDJump":
        try:
            if entry.get("FuelUsed") is not None:
                _fuel["used"] = entry.get("FuelUsed")
        except Exception:
            pass
    if ev == "FSDTarget" and _fuel_on():
        try:
            _fuel_check()
        except Exception:
            pass

    # pirate alarm (BladeRelay assist): somebody is scanning YOUR ship.
    if ev == "Scanned":
        try:
            _pa_scanned(entry)
        except Exception:
            pass

    # b3.9 ★ EARLY WARNING: a hostile NPC opening its mouth, before any interdiction.
    if ev == "ReceiveText":
        try:
            _pa_npc_text(entry)
        except Exception:
            pass

    # b3.9 BACKSTOP: a hostile act within the window turns a pending WARN into the klaxon.
    if ev in ("Interdicted", "UnderAttack", "HullDamage", "ShieldState"):
        try:
            _pa_journal_hostile(ev, entry)
        except Exception:
            pass

    # b3.9 LOCATION GATE input: docking traffic means authority is nearby. Kept as a decaying
    # timestamp rather than a boolean so leaving a station fades out instead of flipping.
    if ev in ("Docked", "Undocked", "DockingRequested", "DockingGranted",
              "DockingDenied", "ApproachSettlement"):
        try:
            _pa_st["near_until"] = time.time() + PIRATE_NEAR_STATION_S
        except Exception:
            pass

    # b3.17 NOFIRE RELEASE. You cannot be in a station no-fire zone in supercruise or
    # mid-hyperspace, and a relog carries no zone state at all. The game does not reliably
    # send `exited` — measured over 655 journals: 914 `entered` while already set, 523
    # FSDJump + 846 SupercruiseEntry with the flag still claiming station space, 294
    # sessions ending latched, longest stale span 260h. So clear on the events that PROVE
    # we left. NOFIRE_TTL_S is the backstop for what these miss; a relog inside a zone is
    # still covered by the Docked/Landed flags and the near_until proxy underneath.
    if ev in ("FSDJump", "SupercruiseEntry", "LoadGame"):
        try:
            _pa_st["nofire_until"] = 0.0
        except Exception:
            pass

    # Learn facility names as the pilot docks at construction sites (planetary + orbital).
    if ev in ("Docked", "DockingRequested", "DockingGranted"):
        _sn = entry.get("StationName") or ""
        _st = entry.get("StationType") or ""
        _mid = entry.get("MarketID")
        if _mid is not None and (_st.endswith("ConstructionDepot") or "construction site:" in _sn.lower()):
            _cn = _clean_site_name(_sn)
            if _cn:
                _SITE_NAMES[str(_mid)] = _cn

    # Report the REAL station type + economy once a site is BUILT. Docked/Location carry
    # them; construction depots and carriers don't. The board maps this to the exact
    # facility type + economy for a completed build (over the generic manifest label).
    if ev in ("Docked", "Location"):
        _mid_s = entry.get("MarketID")
        _st_s = entry.get("StationType") or ""
        if _mid_s is not None and _st_s and not _st_s.endswith("ConstructionDepot") and _st_s != "FleetCarrier":
            _eco_s = entry.get("StationEconomy") or ""
            _sig_s = _st_s + "|" + _eco_s
            if _STATIONMETA_SENT.get(str(_mid_s)) != _sig_s:
                _STATIONMETA_SENT[str(_mid_s)] = _sig_s
                _stp = {
                    "key": INGEST_KEY,
                    "marketId": _mid_s,
                    "stationType": _st_s,
                    "economy": _eco_s,
                    "economyLocalised": entry.get("StationEconomy_Localised") or "",
                    "stationName": entry.get("StationName") or "",
                    "ts": _iso_ms(entry.get("timestamp")),
                }
                threading.Thread(target=_send_station_type, args=(_stp, "station type logged"), daemon=True).start()

    # Track location context from any event that carries it.
    if entry.get("SystemAddress"):
        _state["sa"] = entry["SystemAddress"]
    elif isinstance(state, dict) and state.get("SystemAddress"):
        # isinstance, not truthiness: this line is NOT inside a try, so any truthy non-dict
        # (a string, say) turns into an AttributeError raised straight into EDMC's journal
        # callback. EDMC always passes a dict today; this costs nothing and removes the fuse.
        _state["sa"] = state.get("SystemAddress")
    if system:
        _state["system"] = system
    if entry.get("BodyName"):
        _state["body"] = entry.get("BodyName")
    elif entry.get("Body") and isinstance(entry.get("Body"), str):
        _state["body"] = entry.get("Body")
    if entry.get("BodyID") is not None:
        _state["bodynum"] = entry.get("BodyID")

    # Ship + cargo hold: Loadout carries ship + max cargo, Cargo the current tonnage,
    # LoadGame the ship at login. Report the merged picture to /ingest/loadout (debounced).
    if ev in ("Loadout", "LoadGame", "Cargo"):
        if ev in ("Loadout", "LoadGame"):
            sh = entry.get("Ship")
            if sh:
                _LO["ship"] = str(sh)
            sn = entry.get("ShipName")
            if sn is not None:
                _LO["shipName"] = str(sn)
        if ev == "Loadout":
            cap = entry.get("CargoCapacity")
            if cap is not None:
                try:
                    _LO["cargoCap"] = int(cap)
                except Exception:
                    pass
        if ev == "Cargo":
            cnt = entry.get("Count")
            if cnt is not None:
                try:
                    _LO["cargoUsed"] = int(cnt)
                except Exception:
                    pass
        _maybe_send_loadout(cmdr, _iso_ms(entry.get("timestamp")), force=(ev == "Loadout"))
        return

    # Claims ledger: ColonisationSystemClaim fires when YOU pay for a system claim
    # (at the colonisation contact) — you are the architect; report it. Release undoes it.
    if ev in ("ColonisationSystemClaim", "ColonisationSystemClaimRelease"):
        sa = entry.get("SystemAddress")
        if sa:
            # Cache locally for architect detection during auto-create.
            if ev == "ColonisationSystemClaim":
                _state["claims"][sa] = cmdr or "unknown"
            else:
                _state["claims"].pop(sa, None)
            action = "claim" if ev == "ColonisationSystemClaim" else "release"
            sys_name = entry.get("StarSystem") or system or ""
            payload = {
                "key": INGEST_KEY,
                "systemAddress": sa,
                "systemName": sys_name,
                "cmdr": cmdr or "unknown",
                "action": action,
                "ts": _iso_ms(entry.get("timestamp")),
                "via": "live",
            }
            label = ("architect claim logged: " if action == "claim" else "claim released: ") + (sys_name or str(sa))
            threading.Thread(target=_send_claim, args=(payload, label), daemon=True).start()
        return

    # Fleet-carrier ownership: CarrierStats fires in the owner's own journal when they open
    # carrier management. For a carrier CarrierID == MarketID, which is what Raven's fc-link
    # wants -- report it so the commander deck can offer "link my carrier to a build".
    if ev == "CarrierStats":
        mid = entry.get("CarrierID")
        if mid:
            payload = {
                "key": INGEST_KEY,
                "marketId": mid,
                "callsign": entry.get("Callsign") or "",
                "name": entry.get("Name") or "",
                "cmdr": cmdr or "unknown",
                "ts": _iso_ms(entry.get("timestamp")),
                "via": "live",
            }
            threading.Thread(target=_send_carrier,
                             args=(payload, "carrier logged: " + (entry.get("Name") or entry.get("Callsign") or str(mid))),
                             daemon=True).start()
        return

    if ev != "ColonisationConstructionDepot":
        return

    market_id = entry.get("MarketID")
    sa = _state["sa"] or (state.get("SystemAddress") if state else None)
    if not market_id or not sa:
        return
    if market_id in _state["seen"]:
        return  # already registered this depot

    # Capture commodity requirements from the journal event for Raven create.
    resources = entry.get("ResourcesRequired") or []
    if resources:
        comms = {}
        for r in resources:
            raw = (r.get("Name") or "").lower()
            # Strip ED's "$..._name;" wrapper → bare commodity key
            if raw.startswith("$") and raw.endswith("_name;"):
                raw = raw[1:-6]
            amt = r.get("RequiredAmount", 0)
            if raw and amt:
                comms[raw] = amt
        if comms:
            _state["commodities"][market_id] = comms

    now = time.time()
    _state["pending"].setdefault(market_id, now)

    do_create = False
    if _autocreate() and (now - _state["pending"][market_id]) >= _grace_seconds():
        do_create = True

    payload = {
        "key": INGEST_KEY,
        "marketId": market_id,
        "systemAddress": sa,
        "cmdr": cmdr or "unknown",
        "create": False,  # never ask the CF function to create — plugin does it directly
        "architect": _architect(),
        "systemName": _state.get("system") or system or "",
        "bodyName": _state.get("body") or "",
        "bodyNum": _state.get("bodynum"),
    }
    threading.Thread(target=_post, args=(payload, market_id, do_create), daemon=True).start()
