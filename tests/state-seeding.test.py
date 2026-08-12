#!/usr/bin/env python3
"""EDMC `state` seeding — b3.18 regression tests.

    python3 tests/state-seeding.test.py

Imports the REAL plugin source with EDMC stubbed and drives journal_entry directly.

★ THE SHAPES HERE ARE MEASURED ON THE RIG, NOT GUESSED. Two plausible guesses were wrong,
and both would have shipped a dict into a numeric field:
    state["Cargo"]        -> dict {commodity: count}   (sum the values; NOT a tonnage)
    state["FuelCapacity"] -> dict {"Main":..,"Reserve":..}  (NOT a float)
    state["FuelLevel"]    -> DOES NOT EXIST (live fuel comes from Status.json; only the
                             capacity was ever missing)
Both wrong shapes are kept as negative controls — if someone "simplifies" the isinstance
guards away, these go red.

⚠ FIXTURE TRAP: _hk["flags"]=0x1 is Docked, which makes telemetry report — but Docked ALSO
satisfies _pa_authority_country() by itself, masking the b3.17 latch completely. Use
Supercruise (0x10) when asserting anything about the no-fire flag, or the test cannot fail.
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
    m._pa_alarm=lambda *a,**k: None; m._pa_capture=lambda *a,**k: None; m._pirate_on=lambda: True
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

f=[r for r in R if not r[1]]
for n,p,d in R: print(("  ok   " if p else "  FAIL ")+n+(("   "+d) if d else ""))
print(f"\n{len(R)-len(f)}/{len(R)} passed")
sys.exit(1 if f else 0)
