#!/usr/bin/env python3
"""Pirate-alarm location gate + speaker precedence — replay tests (b3.17).

    python3 tests/pirate-alarm.test.py

Imports the REAL plugin source with the EDMC surface stubbed and a controllable clock, then
drives the actual handlers with synthetic event sequences. Network, klaxon and the capture
log are stubbed out; nothing here touches the rig or the board.

Why these exist: b3.10 replaced an expiring proxy with the game's exact no-fire-zone signal
but cleared it only on `exited`, which the game does not reliably send. Across 655 real
journals the flag was still set during 523 FSDJump and 846 SupercruiseEntry events, 294
sessions ended latched, and the longest stale span was 260 hours.

⚠ Two traps this file exists to remember:
  1. `_pa_npc_text` returns early unless `_pirate_on()` is true AND the entry carries
     Channel:"npc". Miss either and every test silently exercises nothing.
  2. Never advance the clock BY `NOFIRE_TTL_S` to test `NOFIRE_TTL_S` — a test that moves
     with the constant it checks can never fail. Mutation-testing caught exactly that here
     (setting the TTL to 1e12 left the original test green). Assert absolute wall-clock.
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
    for k in list(sys.modules):
        if k=="load": del sys.modules[k]
    spec=importlib.util.spec_from_file_location("load",LOADPY)
    m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
    # no network, no klaxon, no capture files
    def boom(*a,**k): raise RuntimeError("network blocked in test")
    urllib.request.urlopen=boom
    m.alarms=[]
    m._pa_alarm=lambda msg,reason="": m.alarms.append((msg,reason))
    m._pa_capture=lambda *a,**k: None
    m._pirate_on=lambda: True   # feature toggle, otherwise every handler returns early
    # controllable clock
    class T:
        now=1_000_000.0
        def time(self): return T.now
        def sleep(self,*a): pass
        def __getattr__(self,k): import time as _t; return getattr(_t,k)
    m.time=T(); m._T=T
    return m

R=[]; ok=lambda n,c,d="": R.append((n,bool(c),d))
def gate(m): return m._pa_authority_country()
def npc(m,tok,loc=""): m._pa_npc_text({"Channel":"npc","Message":tok,"Message_Localised":loc}, capture=False)
def jrnl(m,ev):
    try: m.journal_entry("BIGSKINNY", True, "Sol", None, {"event":ev}, {})
    except Exception: pass

ENTER="$STATION_NoFireZone_entered;"; EXIT="$STATION_NoFireZone_exited;"

# state name migrated cleanly
m=load(); ok("old boolean key is gone", "nofire" not in m._pa_st and "nofire_until" in m._pa_st)

# entered -> gate true
m=load(); npc(m,ENTER); ok("entered => gate says station space", gate(m) is True)

# exited still works
m=load(); npc(m,ENTER); npc(m,EXIT); ok("exited => released (preserved)", gate(m) is False)

# ★ the fix: events that prove we left
for ev in ["FSDJump","SupercruiseEntry","LoadGame"]:
    m=load(); npc(m,ENTER)
    assert gate(m) is True
    jrnl(m,ev)
    ok(f"{ev} releases the flag", gate(m) is False)

# an event that should NOT release it
m=load(); npc(m,ENTER); jrnl(m,"FSSDiscoveryScan")
ok("unrelated event does NOT release", gate(m) is True)

# TTL backstop: no exit, no jump, just time.
# ⚠ Assert against ABSOLUTE wall-clock, never against NOFIRE_TTL_S itself — a test that
# advances by the constant it is testing moves with it and can never fail. (Caught by
# mutation: setting the TTL to 1e12 left the original version of this test green.)
m=load(); ok("TTL is bounded and sane", 0 < m.NOFIRE_TTL_S <= 7200, f"{m.NOFIRE_TTL_S}s")
m=load(); npc(m,ENTER)
m._T.now += 60;    ok("still latched a minute in", gate(m) is True)
m=load(); npc(m,ENTER)
m._T.now += 86400; ok("flag cannot survive 24h without any event", gate(m) is False)

# ★ the b3.16 scenario end to end: entered, never exited, jumped away
m=load(); npc(m,ENTER); jrnl(m,"FSDJump"); m._T.now += 3600
ok("b3.16 260-hour latch cannot recur", gate(m) is False)

# speaker beats topic
m=load(); npc(m,"$Pirate_OnAuthorityDetection01;","Cops! Scatter!")
ok("$Pirate_OnAuthorityDetection now RAISES a hail", len(m.alarms)==1, str(m.alarms))
m=load(); npc(m,"$Police_ThankYouPassedStopAndSearch01;","Thank you, safe travels")
ok("police token still NOT a pirate hail", len(m.alarms)==0 and gate(m) is True, str(m.alarms))
m=load(); npc(m,"$Pirate_ThreatTooHigh01;","You got lucky")
ok("ordinary pirate token still fires", len(m.alarms)==1)
m=load(); npc(m,"$Military_Patrol01;","Move along")
ok("military still reads as authority", len(m.alarms)==0 and gate(m) is True)

fails=[r for r in R if not r[1]]
for n,p,d in R: print(("  ok   " if p else "  FAIL ")+n+(("   "+d) if d else ""))
print(f"\n{len(R)-len(fails)}/{len(R)} passed")
sys.exit(1 if fails else 0)
