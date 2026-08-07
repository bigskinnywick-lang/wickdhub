# plugin-src — authoritative source for the Blades Registrar EDMC plugin

**This is the source of truth for `load.py`.** Edit `BladesRegistrar/load.py` here, then build.
Do **not** edit the copy inside `docs/blades/BladesRegistrar-beta.zip` directly — that zip is a
build *output*, and hand-editing it is how the real source got lost before.

## Build → cut → auto-update
1. Edit `plugin-src/BladesRegistrar/load.py`. Bump the `PLUGIN_VERSION = "..."  # notes` line —
   a version with a letter (`b3.6`) is a **beta** build, pure-numeric (`3.6`) is **stable**.
2. `python3 plugin-src/build-beta.py` → rebuilds `docs/blades/BladesRegistrar-beta.zip`.
3. Commit the source **and** the zip, push (GitHub Desktop).
4. On the admin **Cut Release** card: it reads the version + notes straight out of the deployed
   zip's `load.py` and pre-fills. Review, then fire **Cut (beta)**.
5. Pilots on the beta track **auto-update**: their installed plugin pulls the new zip on its next
   heartbeat, verifies the sha256, swaps in `load.py`, and prompts an EDMC restart. No manual
   install — updating the site + cutting is the whole distribution step.

## How the zip is built (and why it matters)
The zip must match the layout of every prior release, because two different things read it:
the plugin's own self-updater (`zipfile`, matches `*/load.py`) and the Cut card's minimal ZIP
reader (`functions/blades/api/plugin-release.js` → `findLoadPy`, scans local headers).

The originals were built with the Info-ZIP **`zip` CLI** — the `BladesRegistrar/` directory
entry is **Stored** and `load.py` is **deflated**. `build-beta.py` shells out to that same `zip`
tool (not Python's zipfile, which would deflate the dir entry and drift from convention) and
excludes any stray `__pycache__/*.pyc` so only source ships. Verified 2026-08-06 to match the
b3.5 artifact's structure entry-for-entry.

## Notes
- Stable channel: when a version graduates, build it into `docs/blades/BladesRegistrar.zip`
  (a `build-stable.py` can mirror `build-beta.py`). Today only the beta build is maintained here.
- Current beta: **b3.6** (telemetry live-session gating + liveness refresh).
