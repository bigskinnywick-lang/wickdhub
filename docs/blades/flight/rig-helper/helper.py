#!/usr/bin/env python3
# =====================================================================
# Onyx Blades - Flight Rig live-input helper
# Reads your VIRPIL Alpha stick + Mongoose throttle and pushes button
# presses (and Elite's Status.json toggle flags) to the flight-rig web
# page over a localhost WebSocket:  ws://127.0.0.1:8317
#
# HOW TO RUN:  double-click run.bat   (or:  python helper.py)
# Then open the flight-rig page in Chrome/Edge ON THIS SAME PC.
# Press buttons on the rig -> the matching marker lights up, and the
# console prints e.g.  "throttle Joy_58 DOWN"  so you can map controls.
# =====================================================================

import os, sys, json, asyncio

# Force SDL's DirectInput path so the throttle's high buttons (Joy_56+)
# aren't capped at 32. Must be set before pygame initialises the joystick.
os.environ.setdefault("SDL_JOYSTICK_RAWINPUT", "0")

PORT = 8317
STATUS_PATH = os.path.expandvars(
    r"%USERPROFILE%\Saved Games\Frontier Developments\Elite Dangerous\Status.json"
)

# --- device name -> which stage on the page ("throttle" / "stick") ----
def stage_for(name):
    n = (name or "").lower()
    if any(k in n for k in ("throttle", "mongoos", "cm3", "tcs")):
        return "throttle"
    if any(k in n for k in ("stick", "alpha", "constellation", "grip", "mt-50", "mt50")):
        return "stick"
    return None  # unknown -> shown at startup; hard-map it in HARD below

# If the auto-guess puts a device on the wrong stage, fill this in after you
# see the startup list. Keys = the "device N" index printed at launch.
#   e.g.  HARD = {0: "throttle", 1: "stick"}
HARD = {}

try:
    import pygame
except ImportError:
    print("\n[!] pygame not installed.  Run:  pip install pygame websockets\n")
    sys.exit(1)
try:
    import websockets
except ImportError:
    print("\n[!] websockets not installed.  Run:  pip install pygame websockets\n")
    sys.exit(1)

clients = set()
state = {"throttle": {}, "stick": {}}   # Joy_N (1-based) -> pressed bool
flags = None


def log(*a):
    print("[rig]", *a, flush=True)


async def broadcast(msg):
    if not clients:
        return
    data = json.dumps(msg)
    for ws in list(clients):
        try:
            await ws.send(data)
        except Exception:
            clients.discard(ws)


async def ws_handler(ws, *_):
    clients.add(ws)
    log(f"page connected ({len(clients)} open)")
    try:
        # snapshot so a freshly-loaded page shows held buttons + toggle state
        if flags is not None:
            await ws.send(json.dumps({"type": "flags", "flags": flags}))
        for dev, m in state.items():
            for n, on in m.items():
                if on:
                    await ws.send(json.dumps({"type": "btn", "dev": dev, "n": n, "down": True}))
        async for _msg in ws:
            pass  # page doesn't send us anything; just hold the connection
    except Exception:
        pass
    finally:
        clients.discard(ws)
        log(f"page disconnected ({len(clients)} open)")


def init_joysticks():
    pygame.init()
    pygame.joystick.init()
    devs = []
    n = pygame.joystick.get_count()
    log(f"found {n} device(s):")
    for i in range(n):
        j = pygame.joystick.Joystick(i)
        j.init()
        name = j.get_name()
        st = HARD.get(i) or stage_for(name)
        devs.append((j, st))
        tag = st or "UNMAPPED  <- add to HARD in helper.py"
        log(f"  device {i}: '{name}'  buttons={j.get_numbuttons()}  ->  {tag}")
    if not devs:
        log("no joysticks detected - plug in the rig and restart.")
    return devs


async def poll_loop():
    global flags
    devs = init_joysticks()
    last_mtime = 0
    log("ready. press rig buttons; open the flight page on this PC.")
    while True:
        pygame.event.pump()
        for j, st in devs:
            if not st:
                continue
            for b in range(j.get_numbuttons()):
                on = bool(j.get_button(b))
                joy = b + 1               # Elite's Joy_N is 1-based; SDL is 0-based
                if on != state[st].get(joy, False):
                    state[st][joy] = on
                    if on:
                        log(f"{st} Joy_{joy} DOWN")
                    await broadcast({"type": "btn", "dev": st, "n": joy, "down": on})
        # Elite Status.json flags (lights / gear / scoop / night-vision ...)
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
        await asyncio.sleep(0.008)   # ~120 Hz


async def main():
    log(f"Onyx Blades flight-rig helper  -  ws://127.0.0.1:{PORT}")
    async with websockets.serve(ws_handler, "127.0.0.1", PORT):
        await poll_loop()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\n[rig] stopped.")
