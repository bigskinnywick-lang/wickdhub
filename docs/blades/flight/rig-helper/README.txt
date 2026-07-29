============================================================
 ONYX BLADES - FLIGHT RIG HELPER  (Phase B)
 Live HOTAS input for  wickdhub.com/blades/beta/flight/
============================================================

WHAT THIS DOES
  Reads your VIRPIL Alpha stick + Mongoose throttle and sends every
  button press to the flight-rig web page, so the matching marker on
  the picture lights up in real time. It also reads Elite's Status.json
  so the Lights / Gear / Scoop / Night-Vision toggles show ON/OFF.

------------------------------------------------------------
WHAT YOU NEED  (one time)
------------------------------------------------------------
  - This PC, with the rig plugged in.
  - Python 3. If you don't have it: https://www.python.org/downloads/
    IMPORTANT: on the installer's FIRST screen, tick
    "Add python.exe to PATH", then install.

------------------------------------------------------------
TO RUN
------------------------------------------------------------
  1. Double-click  run.bat  (in this folder).
       - First run installs two small packages (pygame, websockets).
         Let it finish. The window then lists the devices it found and
         stays open -- LEAVE IT OPEN while you fly.
  2. Open Chrome or Edge ON THIS PC and go to:
         https://wickdhub.com/blades/beta/flight/
       (sign in with your Onyx Blades access if asked).
  3. Bottom-right of the page should show a green   * RIG LIVE   pill.
  4. Press buttons on the rig. Bound controls glow, and the bar along
     the bottom shows what came in, e.g.  THROTTLE Joy_58 -> B3
     (or UNMAPPED for anything not wired yet).

  To stop: close the black window (or press Ctrl+C in it).

------------------------------------------------------------
SEND THESE BACK TO CLAUDE  (to finish the mapping)
------------------------------------------------------------
  a) The device list the window prints at startup -- the names, the
     button counts, and the " -> throttle / stick" each one got.
  b) Press B1 (heat sink); tell Claude the Joy number the bottom bar
     shows. It should read  Joy_56.  If it's different, Claude fixes it.

  Then the fun part: press each un-lit (dashed) control, read its Joy
  number off the bottom bar, and tell Claude which marker it is --
  Claude wires it up. No VPC profile needed.

------------------------------------------------------------
IF SOMETHING'S OFF
------------------------------------------------------------
  - "Python was not found": install Python (above), tick Add to PATH,
    then run run.bat again.
  - A device shows "UNMAPPED" or lands on the wrong stage: send Claude
    the exact device names + counts; Claude sets a HARD override.
  - Throttle shows only 32 buttons but should have more: tell Claude.
  - Green pill never appears: check the black window is still open, the
    page is on THIS PC, and you're in Chrome or Edge. Refresh once.
  - Windows Firewall popup for Python: allow it (Private networks).

------------------------------------------------------------
  WS port: 127.0.0.1:8317      Page: wickdhub.com/blades/beta/flight/
  Files here: helper.py (the program) + run.bat (launcher)
============================================================
