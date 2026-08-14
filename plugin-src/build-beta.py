#!/usr/bin/env python3
"""Shim — kept so the documented `python3 plugin-src/build-beta.py` still works.

The real builder is build.py, which handles BOTH channels and refuses to build a zip whose
PLUGIN_VERSION does not match the channel. Equivalent to:

    python3 plugin-src/build.py beta
"""
import os
import runpy
import sys

sys.argv = [os.path.join(os.path.dirname(os.path.abspath(__file__)), "build.py"), "beta"]
runpy.run_path(sys.argv[0], run_name="__main__")
