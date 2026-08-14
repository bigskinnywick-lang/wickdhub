#!/usr/bin/env python3
"""Build a Blades Registrar plugin zip from the authoritative source, for either channel.

  Source of truth : plugin-src/BladesRegistrar/load.py   <- edit HERE, never the zip directly
  Output artifact : docs/blades/BladesRegistrar.zip       (stable)
                    docs/blades/BladesRegistrar-beta.zip  (beta)

Usage:
  python3 plugin-src/build.py stable
  python3 plugin-src/build.py beta        # or the build-beta.py shim, kept for muscle memory
  # then commit the zip, PUSH (the site deploys from the repo), and only THEN fire Cut on the
  # admin card. Cut hashes the LIVE deployed zip -- cutting before the deploy hashes the old file.

★ THE CHANNEL IS DECIDED BY THE VERSION STRING, NOT BY THIS SCRIPT.
`PLUGIN_VERSION` in load.py self-designates: pure-numeric = stable ("3.0"), anything containing
a letter = beta ("b3.27"). Both the plugin (`_is_beta`, load.py:504) and the Cut endpoint
(`isBeta`, functions/blades/api/plugin-release.js:52) agree on that rule, and Cut REFUSES a zip
whose version does not match the channel being cut. So this script checks it here too and fails
loudly rather than letting you push an artifact the Cut card will reject.

★ Why it shells out to the `zip` CLI. The original artifacts were built with Info-ZIP: the
`BladesRegistrar/` directory entry is STORED and `load.py` is deflated. Python's zipfile would
deflate the directory entry and drift from every prior release. Compiled bytecode is excluded so
only source ships.

⚠ This script begins by DELETING the output (zip -r would otherwise ADD to the existing archive),
so it CANNOT run under the Cowork sandbox mount, which forbids unlink. Run it natively.
"""
import os
import re
import subprocess
import sys

CHANNELS = {"stable": "BladesRegistrar.zip", "beta": "BladesRegistrar-beta.zip"}

HERE = os.path.dirname(os.path.abspath(__file__))
LOAD_PY = os.path.join(HERE, "BladesRegistrar", "load.py")


def read_version():
    """Read PLUGIN_VERSION the same way the Cut endpoint's parseMeta() does."""
    with open(LOAD_PY, encoding="utf-8") as fh:
        text = fh.read()
    m = re.search(r"""PLUGIN_VERSION\s*=\s*["']([^"']+)["']""", text)
    if not m:
        sys.exit("could not find PLUGIN_VERSION in %s" % LOAD_PY)
    return m.group(1).strip()


def is_beta(v):
    """Mirror of load.py `_is_beta` and plugin-release.js `isBeta`: any letter means beta."""
    return bool(re.search(r"[A-Za-z]", v))


def main():
    channel = (sys.argv[1] if len(sys.argv) > 1 else "").lower()
    if channel not in CHANNELS:
        sys.exit("usage: build.py {stable|beta}")

    version = read_version()
    want_beta = channel == "beta"
    if is_beta(version) != want_beta:
        sys.exit(
            'PLUGIN_VERSION is "%s", which is %s, but you asked to build %s.\n'
            "The Cut card would refuse this zip. Fix the version in load.py first "
            "(pure number = stable, any letter = beta)."
            % (version, "BETA" if is_beta(version) else "STABLE", channel.upper())
        )

    out = os.path.normpath(os.path.join(HERE, "..", "docs", "blades", CHANNELS[channel]))
    if os.path.exists(out):
        os.remove(out)  # zip -r ADDS to an existing archive rather than replacing it

    subprocess.run(
        ["zip", "-r", "-X", out, "BladesRegistrar", "-x", "*/__pycache__/*", "*.pyc"],
        cwd=HERE, check=True,
    )
    print("wrote %s  (channel=%s, PLUGIN_VERSION=%s)" % (out, channel, version))


if __name__ == "__main__":
    main()
