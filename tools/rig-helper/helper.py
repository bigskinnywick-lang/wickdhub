#!/usr/bin/env python3
# =====================================================================
# Onyx Blades - Flight Rig live-input helper  (v2: buttons + hats + axes)
# Reads your VIRPIL Alpha stick + Mongoose throttle and pushes input to
# the flight-rig web page over a localhost WebSocket:  ws://127.0.0.1:8317
#
# RUN:  double-click run.bat   (or:  python helper.py)
# Then open the flight-rig page in Chrome/Edge ON THIS SAME PC.
#
# v2 adds:
#   - HATS  (POV hats)  -> shows "throttle Hat0 UP" etc.
#   - AXES  (mini-stick, dials/encoders, sliders) -> shows "throttle Axis3"
#     when you move one past the deadzone (so analog controls are visible).
# Buttons still print/send exactly as before.
# =====================================================================

import os, sys, json, asyncio

os.environ.setdefault("SDL_JOYSTICK_RAWINPUT", "0")   # expose >32 buttons

PORT = 8317
STATUS_PATH = os.path.expandvars(
    r"%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous\Status.json"
)
AXIS_ON, AXIS_OFF = 0.6, 0.4   # deadzone / hysteresis for "axis moved"

def stage_for(name):
    n = (name or "").lower()
    if any(k in n for k in ("throttle", "mongoos", "cm3", "tcs")):
        return "throttle"
    if any(k in n for k in ("stick", "alpha", "constellation", "grip", "mt-50", "mt50")):
        return "stick"
    return None

HARD = {}   # e.g. {0: "throttle", 1: "stick"} if the auto-guess is wrong

try:
    import pygame
except ImportError:
    print("\n[!] pygame not installed.  Run:  pip install pygame websockets\n"); sys.exit(1)
try:
    import websockets
except ImportError:
    print("\n[!] websockets not installed.  Run:  pip install pygame websockets\n"); sys.exit(1)

clients = set()
btn_state  = {}   # (stage, n) -> bool
hat_state  = {}   # (stage, h) -> (x, y)
axis_state = {}   # (stage, a) -> bool (currently past deadzone)
flags = None

def log(*a): print("[rig]", *a, flush=True)

def hatdir(val):
    x, y = val
    d = ("UP" if y > 0 else "DOWN" if y < 0 else "") + (" RIGHT" if x > 0 else " LEFT" if x < 0 else "")
    return d.strip() or "center"

async def broadcast(msg):
    if not clients: return
    data = json.dumps(msg)
    for ws in list(clients):
        try: await ws.send(data)
        except Exception: clients.discard(ws)

async def ws_handler(ws, *_):
    clients.add(ws)
    log(f"page connected ({len(clients)} open)")
    try:
        if flags is not None:
            await ws.send(json.dumps({"type": "flags", "flags": flags}))
        for (st, n), on in btn_state.items():
            if on: await ws.send(json.dumps({"type": "btn", "dev": st, "n": n, "down": True}))
        async for _m in ws:
            pass
    except Exception:
        pass
    finally:
        clients.discard(ws)
        log(f"page disconnected ({len(clients)} open)")

def init_joysticks():
    pygame.init(); pygame.joystick.init()
    devs = []
    n = pygame.joystick.get_count()
    log(f"found {n} device(s):")
    for i in range(n):
        j = pygame.joystick.Joystick(i); j.init()
        st = HARD.get(i) or stage_for(j.get_name())
        devs.append((j, st))
        log(f"  device {i}: '{j.get_name()}'  buttons={j.get_numbuttons()} "
            f"hats={j.get_numhats()} axes={j.get_numaxes()}  ->  {st or 'UNMAPPED (set HARD)'}")
    if not devs:
        log("no joysticks detected - plug in the rig and restart.")
    return devs

async def poll_loop():
    global flags
    devs = init_joysticks()
    last_mtime = 0
    log("ready. press / move rig controls; watch the page monitor.")
    while True:
        pygame.event.pump()
        for j, st in devs:
            if not st: continue
            # buttons
            for b in range(j.get_numbuttons()):
                on = bool(j.get_button(b)); joy = b + 1
                if on != btn_state.get((st, joy), False):
                    btn_state[(st, joy)] = on
                    if on: log(f"{st} Joy_{joy} DOWN")
                    await broadcast({"type": "btn", "dev": st, "n": joy, "down": on})
            # hats (POV)
            for h in range(j.get_numhats()):
                val = j.get_hat(h)
                if val != hat_state.get((st, h)):
                    hat_state[(st, h)] = val
                    if val != (0, 0): log(f"{st} Hat{h} {hatdir(val)}")
                    await broadcast({"type": "hat", "dev": st, "n": h, "x": val[0], "y": val[1]})
            # axes (mini-stick / dials / sliders) - report on deadzone crossing
            for a in range(j.get_numaxes()):
                v = j.get_axis(a); was = axis_state.get((st, a), False)
                if abs(v) > AXIS_ON and not was:
                    axis_state[(st, a)] = True
                    log(f"{st} Axis{a} = {v:+.2f}")
                    await broadcast({"type": "axis", "dev": st, "n": a, "v": round(v, 2)})
                elif abs(v) < AXIS_OFF and was:
                    axis_state[(st, a)] = False
                    await broadcast({"type": "axis", "dev": st, "n": a, "v": 0})
        # Elite Status.json flags
        try:
            m = os.path.getmtime(STATUS_PATH)
            if m != last_mtime:
                last_mtime = m
                with open(STATUS_PATH, "r") as f:
                    d = json.load(f)
                fl = d.get("Flags")
                if isinstance(fl, int) and fl != flags:
                    flags = fl
                    await broadcast({"type": "flags", "flags": flags})
        except FileNotFoundError:
            pass
        except Exception:
            pass
        await asyncio.sleep(0.008)

async def main():
    log(f"Onyx Blades flight-rig helper v2  -  ws://127.0.0.1:{PORT}")
    async with websockets.serve(ws_handler, "127.0.0.1", PORT):
        await poll_loop()

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[rig] stopped.")
