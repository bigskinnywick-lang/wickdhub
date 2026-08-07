#!/usr/bin/env python3
"""Build the Blades Registrar BETA plugin zip from the authoritative source.

  Source of truth : plugin-src/BladesRegistrar/load.py   <- edit HERE, never the zip directly
  Output artifact : docs/blades/BladesRegistrar-beta.zip  <- what the admin Cut card reads

Why this exists: the plugin's load.py used to live ONLY inside the committed zip, with no
loose copy, so "where is the real source?" had no answer. This makes plugin-src/ the source
of truth and the zip a reproducible build output.

HOW the zip is built matters — it must match the existing artifact's structure so it stays
consistent with every prior release. The originals were built with the Info-ZIP `zip` CLI:
the `BladesRegistrar/` directory entry is STORED and `load.py` is deflated. So this script
shells out to the same `zip` tool rather than Python's zipfile (which would deflate the dir
entry and drift from convention). It also excludes any stray __pycache__/*.pyc so only source
ships. The Cut endpoint (functions/blades/api/plugin-release.js -> findLoadPy) scans ZIP local
headers for */load.py and reads PLUGIN_VERSION off it to fill the Cut card.

Usage:
  python3 plugin-src/build-beta.py
  # then commit docs/blades/BladesRegistrar-beta.zip, push, and fire Cut (beta) on the admin card.
"""
import os
import subprocess

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.normpath(os.path.join(HERE, "..", "docs", "blades", "BladesRegistrar-beta.zip"))

if os.path.exists(OUT):
    os.remove(OUT)  # zip -r would otherwise ADD to an existing archive

# -r recurse into BladesRegistrar/, -X drop extra file attributes; exclude any compiled
# bytecode so only the source package ships. Run from plugin-src/ so paths inside the zip
# start at "BladesRegistrar/".
subprocess.run(
    ["zip", "-r", "-X", OUT, "BladesRegistrar", "-x", "*/__pycache__/*", "*.pyc"],
    cwd=HERE, check=True,
)
print("wrote", OUT)
