@echo off
title Onyx Blades - Flight Rig Helper
cd /d "%~dp0"

echo ============================================================
echo   ONYX BLADES - FLIGHT RIG HELPER
echo ============================================================
echo.

REM --- make sure Python is available ---
python --version >nul 2>&1
if errorlevel 1 (
  echo [!] Python was not found on this PC.
  echo     Install it from https://www.python.org/downloads/  ^(tick "Add to PATH"^)
  echo.
  pause
  exit /b 1
)

echo Checking dependencies ^(first run installs pygame + websockets^)...
python -m pip install --quiet --disable-pip-version-check pygame websockets

echo.
echo Starting helper. Leave this window open while you fly.
echo Open the flight-rig page in Chrome/Edge on THIS PC.
echo Press Ctrl+C or close this window to stop.
echo ------------------------------------------------------------
python "%~dp0helper.py"

echo.
echo Helper stopped. Press any key to close.
pause >nul
