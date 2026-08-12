#!/usr/bin/env python3
"""Pirate alarm + EDMC state seeding — regression tests (b3.17 → b3.20).

    python3 tests/state-seeding.test.py

Imports the REAL plugin source with EDMC stubbed and drives the handlers directly.

★ REPLAYS THE FIRST REAL PIRATE, captured 2026-08-12 at a nav beacon. Tokens are verbatim
from _Handoff/refs/pirate-scan-capture-2026-08-12.jsonl. That night measured five Cargo
scans: FOUR police, ONE pirate. Only TIMING separated them — the pirate spoke ~10s BEFORE
the scan, police only ever at +0s after it. Location and cargo discriminated nothing, and
all three false warns were laden-in-station-space. Hence b3.20: a bare `Scanned` logs info
and never warns, while the hail path (1-for-1 on real data) is untouched.

★ SHAPES ARE MEASURED, NOT GUESSED — two guesses were wrong and would have put a dict in a
numeric field:  state["Cargo"] is a commodity->count dict;  state["FuelCapacity"] is a dict
keyed "Main";  state["FuelLevel"] does not exist;  CargoJSON["Count"] is the game's own
total but is None on an empty hold, so the Cargo sum is the only correct empty-hold branch.
Both wrong shapes are kept as negative controls.

⚠ THREE FIXTURE TRAPS, each of which made this suite lie before it was fixed:
  1. Do NOT stub `_pa_alarm` — it is what RAISES the critical alert, so stubbing it makes
     every "did the klaxon fire?" assertion silently unfalsifiable. Stub `_alarm_blare`
     (the PC beeper) and `_refocus_on` instead.
  2. `_hk["flags"]=0x1` is Docked, which lets telemetry report — but Docked ALSO satisfies
     `_pa_authority_country()` on its own, masking the b3.17 no-fire latch entirely. Use
     Supercruise (0x10) when asserting anything about that flag.
  3. Never advance the clock BY `NOFIRE_TTL_S` to test `NOFIRE_TTL_S`; a test that moves
     with its own constant can never fail. Assert absolute wall-clock.

Alerts are capped at `_ALERT_MSG_MAX` (90) chars. Anything built by concatenation must be
counted, not eyeballed — the first b3.20 wording was 100 and shipped truncated mid-word.
"""
import os
LOADPY = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..",
                      "plugin-src", "BladesRegistrar", "load.py")
import sys, types, importlib.util, urllib.request
def load():
    for n in ["myNotebook","config","theme","plug","l10n","EDMCLogging","monitor","ttkHyperlinkLabel"]:
        sys.modules[n]=types.ModuleType(n)
    sys.modules["config"].config=types.SimpleNamespace(get_str=lambda *a,**k:"",get_int=lambda *a,**k:0,
        get_bool=lambda *a,**k:False,set=lambda *a,**k:None,appversion=lambda:"5.0")
    sys.modules["config"].appname="EDMC"
    sys.modules.pop("load",None)
    spec=importlib.util.spec_from_file_location("load",LOADPY)
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    def boom(*a,**k): raise RuntimeError("no network in test")
    urllib.request.urlopen=boom
    m._pa_capture=lambda *a,**k: None; m._pirate_on=lambda: True
    m._alarm_blare=lambda *a,**k: None          # silence the PC klaxon ONLY
    m._refocus_on=lambda: False                 # no window poking in a test
    # NOTE: do NOT stub _pa_alarm — it is what raises the critical alert. Stubbing it makes
    # every "did the klaxon fire?" assertion silently unfalsifiable (it did, first attempt).
    m._hk["flags"]=0x1                      # Docked -> telemetry is allowed to report
    return m

# EXACT shapes measured on the rig (NOT guessed): Cargo is a dict, FuelCapacity is a dict,
# and there is no FuelLevel key.
def rig_state(cargo=None, **over):
    st={"ShipType":"panthermkii","ShipName":"Kudzu","ShipIdent":"6x64","CargoCapacity":1104,
        "Cargo":{} if cargo is None else cargo,
        "FuelCapacity":{"Main":128.0,"Reserve":1.11},
        "SystemName":"Col 285 Sector BU-O b7-3","SystemAddress":7269634942297,
        "IsDocked":True,"StationName":"Orbital Construction Site: Collora's Progress"}
    st.update(over); return st
def je(m, ev, state, system=None, entry=None):
    e=entry or {"event":ev}; e.setdefault("event",ev)
    try: m.journal_entry("BIGSKINNY", True, system, None, e, state)
    except Exception as ex: print("   journal_entry raised:", type(ex).__name__, ex)

R=[]; ok=lambda n,c,d="": R.append((n,bool(c),d))

# ── the exact rig scenario: EDMC restarted mid-session, first callback is StartUp ──
m=load()
ok("before any event: nothing known", not m._LO["ship"] and m._fuel.get("cap") is None and not m._state.get("system"))
je(m,"StartUp",rig_state(),system=None)      # system param deliberately None
t=m._assist_telemetry()
ok("ship seeded from state", t.get("ship")=="panthermkii", str(t.get("ship")))
ok("shipName seeded", m._LO["shipName"]=="Kudzu")
ok("cargoCap seeded as INT", t.get("cargoCap")==1104 and isinstance(t.get("cargoCap"),int))
ok("fuelPct computed (cap came from the DICT)", t.get("fuelPct") is None or isinstance(t.get("fuelPct"),int))
ok("_fuel cap is a NUMBER not a dict", isinstance(m._fuel.get("cap"),(int,float)), repr(m._fuel.get("cap")))
ok("sys seeded even with system=None", t.get("sys")=="Col 285 Sector BU-O b7-3", str(t.get("sys")))
ok("system address seeded", m._state.get("sa")==7269634942297)

# fuel% must be REAL once Status.json supplies the live level
m._fuel["main"]=64.0
ok("fuelPct = 50% from 64/128", m._assist_telemetry().get("fuelPct")==50, str(m._assist_telemetry().get("fuelPct")))

# ── the unverified shape: a LOADED hold ──
m=load(); je(m,"StartUp",rig_state(cargo={"gold":12,"tritium":30,"water":8}))
ok("cargoUsed = SUM of the dict (50)", m._assist_telemetry().get("cargo")==50, str(m._assist_telemetry().get("cargo")))
m=load(); je(m,"StartUp",rig_state(cargo={}))
ok("empty hold -> cargo 0, not None", m._assist_telemetry().get("cargo")==0, str(m._assist_telemetry().get("cargo")))

# ── seeding must NEVER clobber fresher journal-derived values ──
m=load(); m._LO["ship"]="python"; m._LO["cargoUsed"]=7
je(m,"StartUp",rig_state(cargo={"gold":99}))
ok("existing ship not overwritten", m._LO["ship"]=="python")
ok("existing cargoUsed not overwritten", m._LO["cargoUsed"]==7)
m=load(); m._state["system"]="Sol"; je(m,"StartUp",rig_state())
ok("existing system not overwritten by seed", m._state["system"]=="Sol")

# ── the live `system` param still wins for ongoing updates ──
m=load(); je(m,"StartUp",rig_state()); je(m,"FSDJump",rig_state(),system="Shinrarta Dezhra",
    entry={"event":"FSDJump","SystemAddress":123,"StarSystem":"Shinrarta Dezhra"})
ok("jump updates sys via the system param", m._assist_telemetry().get("sys")=="Shinrarta Dezhra", str(m._assist_telemetry().get("sys")))

# ── hostile / malformed state must never raise ──
for bad in [None, {}, {"ShipType":"x","FuelCapacity":128.0,"Cargo":5,"CargoCapacity":"1104"}, {"ShipType":None}, "notadict", 42, []]:
    m=load(); raised=[]
    try: m.journal_entry("BIGSKINNY", True, None, None, {"event":"StartUp"}, bad)
    except Exception as ex: raised.append(type(ex).__name__+": "+str(ex))
    ok("malformed state raises NOTHING: "+repr(bad)[:26], not raised, raised[0] if raised else "")
m=load(); je(m,"StartUp",{"ShipType":"x","FuelCapacity":128.0,"Cargo":5,"CargoCapacity":"1104"})
ok("flat FuelCapacity ignored, cap stays None", m._fuel.get("cap") is None, repr(m._fuel.get("cap")))
ok("non-dict Cargo ignored, cargoUsed stays None", m._LO.get("cargoUsed") is None, repr(m._LO.get("cargoUsed")))
ok("non-int CargoCapacity ignored", m._LO.get("cargoCap") is None, repr(m._LO.get("cargoCap")))

# ── b3.17 must still hold ──
# ⚠ _hk["flags"]=0x1 (Docked) is set at load so telemetry will report — but Docked ALSO
# satisfies _pa_authority_country() on its own, which masks the latch entirely. Use
# Supercruise (0x10) for this one, or the assertion can never fail. (It didn't, first time.)
m=load(); m._hk["flags"]=0x10; m._pa_st["nofire_until"]=m.time.time()+999
ok("latch holds before the jump", m._pa_authority_country() is True)
je(m,"FSDJump",rig_state(),system="Sol")
ok("b3.17 nofire release still works", m._pa_authority_country() is False)

# ══ b3.20: REPLAY THE REAL NIGHT ═════════════════════════════════════════════════════════
# Verbatim tokens from _Handoff/refs/pirate-scan-capture-2026-08-12.jsonl
PIRATE_HAIL = "$Pirate_OnStartScanCargo09;"
PIRATE_DONE = "$Pirate_OnNoCargoFound09;"
POLICE_DONE = "$Police_ThankYouPassedStopAndSearch02;"
def alerts(m): return [(a["l"], a["m"]) for a in m._alerts]
def npc2(m,tok,loc=""): m._pa_npc_text({"Channel":"npc","Message":tok,"Message_Localised":loc}, capture=False)
def scan(m,kind="Cargo"): m._pa_scanned({"event":"Scanned","ScanType":kind})

# ── the PIRATE sequence, exactly as it happened (hail at -10s, scan at 0) ──
m=load(); m._hk["flags"]=0x10
npc2(m,PIRATE_HAIL,"The scan will soon be over.")
a=alerts(m)
ok("PIRATE hail raises CRITICAL", any(l=="critical" and "PIRATE INBOUND" in msg for l,msg in a), str(a))
ok("caught by TOKEN, not the phrase list", not any("(phrase)" in msg for l,msg in a), str(a))
scan(m)
a=alerts(m)
ok("the following scan does NOT double-alarm", sum(1 for l,_ in a if l=="critical")==1, str(a))
ok("following scan logs info 'already alarmed'", any(l=="info" and "already alarmed" in msg for l,msg in a))

# ── the POLICE sequence: a bare scan with NO hail first ──
# ★ the exact false-positive shape: LADEN, in STATION SPACE — 3 of these fired warns on 8-12
m=load(); m._hk["flags"]=0x1                      # Docked -> station space
m._LO["cargoUsed"]=64; m._LO["cargoCap"]=1104     # laden
scan(m)
a=alerts(m)
ok("★ bare scan raises NO warn (was 0-for-3)", not any(l=="warn" for l,_ in a), str(a))
ok("★ bare scan raises NO critical", not any(l=="critical" for l,_ in a), str(a))
ok("bare scan IS logged as info", any(l=="info" for l,_ in a), str(a))
ok("info names the missing hail (countable)", any("no hail first" in msg for l,msg in a), str(a))
ok("info records laden + location", any("laden" in msg and "station space" in msg for l,msg in a), str(a))
ok("info line does NOT shout PIRATE", not any(l=="info" and "PIRATE SCAN" in msg for l,msg in a), str(a))
ok("every alert fits the 90-char cap", all(len(msg)<=90 for l,msg in a), str([len(m) for _,m in a]))

# ── QUIETER, NOT BLINDER: an unannounced scan followed by hostility must still klaxon ──
m=load(); m._hk["flags"]=0x10
scan(m)
ok("no klaxon yet", not any(l=="critical" for l,_ in alerts(m)))
m._pa_journal_hostile("UnderAttack", {"event":"UnderAttack"})
ok("★ scan THEN attack still escalates to critical", any(l=="critical" for l,_ in alerts(m)), str(alerts(m)))

# ── crime scans unchanged ──
m=load(); m._hk["flags"]=0x1; scan(m,"Crime")
ok("crime scan still info-only", alerts(m) and all(l=="info" for l,_ in alerts(m)), str(alerts(m)))

# ── police token still not a pirate (b3.17 regression) ──
m=load(); m._hk["flags"]=0x1; npc2(m,POLICE_DONE,"Thank you, safe travels")
ok("police token raises nothing", not any(l in ("warn","critical") for l,_ in alerts(m)), str(alerts(m)))

# ── b3.20 cargo seeding: CargoJSON Count preferred, Cargo sum as the empty-hold branch ──
m=load(); je(m,"StartUp",rig_state(cargo={"water":7}, CargoJSON={"Count":123,"Inventory":[],"Vessel":1}))
ok("CargoJSON Count preferred over summing", m._LO["cargoUsed"]==123, str(m._LO["cargoUsed"]))
m=load(); je(m,"StartUp",rig_state(cargo={"gold":12,"tritium":30}))   # CargoJSON absent
ok("falls back to summing Cargo", m._LO["cargoUsed"]==42, str(m._LO["cargoUsed"]))
m=load(); je(m,"StartUp",rig_state(cargo={}, CargoJSON=None))          # empty hold
ok("empty hold -> 0 via the fallback (CargoJSON is None)", m._LO["cargoUsed"]==0, str(m._LO["cargoUsed"]))
m=load(); je(m,"StartUp",rig_state(cargo={"x":5}, CargoJSON={"Count":"nope"}))
ok("malformed CargoJSON Count ignored, sum used", m._LO["cargoUsed"]==5, str(m._LO["cargoUsed"]))

f=[r for r in R if not r[1]]
for n,p,d in R: print(("  ok   " if p else "  FAIL ")+n+(("   "+d) if d else ""))
print(f"\n{len(R)-len(f)}/{len(R)} passed")
sys.exit(1 if f else 0)
