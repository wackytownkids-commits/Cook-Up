#!/usr/bin/env bash
#
# Build Cookup.command
# Double-click this file to build Cookup.dmg.
# No typing needed.
#
# On first run it installs the stuff it needs (Electron + portable Python +
# MusicGen). That's a one-time ~20 minute wait. Later builds are fast.

set -e

# Jump to the folder this file lives in (not the user's home).
cd "$(dirname "$0")"

# Pretty banner in the Terminal window that pops up.
clear
cat <<'BANNER'
=================================================
               Cookup Builder
=================================================
Don't close this window.
Progress will be printed below. When it's done, a
dialog will pop up and Finder will open to the DMG.
=================================================
BANNER
echo

# --- 1. Make sure Node.js is installed ---
if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed."
  osascript -e 'display dialog "Cookup needs Node.js to build. I will open the Node.js download page now. Install the LTS version (the green button), then double-click Build Cookup.command again." buttons {"Open nodejs.org"} default button 1 with icon caution with title "Cookup"' >/dev/null || true
  open "https://nodejs.org/en/download/"
  exit 1
fi
echo "[ok] Node.js found: $(node --version)"

# --- 2. npm install (Electron dependencies) ---
if [ ! -d node_modules ]; then
  echo
  echo "Step 1 of 3: installing Electron..."
  npm install
else
  echo "[ok] Electron deps already installed."
fi

# --- 3. bundle Python + MusicGen (one-time, big) ---
if [ ! -x python-runtime/bin/python3 ]; then
  echo
  echo "Step 2 of 3: bundling Python and MusicGen (this is the slow one, ~15 min)..."
  bash scripts/bundle-python.sh
else
  echo "[ok] python-runtime/ already bundled."
fi

# --- 4. build the DMG ---
echo
echo "Step 3 of 3: building the DMG..."
# Call electron-builder directly; we already bundled Python above so we skip
# the dist:mac script that would re-run the bundler.
npx electron-builder --mac

# --- 5. celebrate ---
echo
echo "Build finished."
DMG="$(ls -t dist/Cookup-*.dmg 2>/dev/null | head -n1 || true)"

if [ -n "$DMG" ] && [ -f "$DMG" ]; then
  echo "[ok] DMG: $DMG"
  # Show a friendly dialog and reveal the DMG in Finder.
  osascript -e 'display dialog "Cookup.dmg is ready. I will reveal it in Finder now. Double-click the DMG, drag Cookup to Applications, and you are done." buttons {"Show me"} default button 1 with title "Cookup"' >/dev/null || true
  open -R "$DMG"
else
  osascript -e 'display dialog "The build finished but I could not find a DMG in dist/. Scroll up in the Terminal window to see what went wrong." buttons {"OK"} default button 1 with icon caution with title "Cookup"' >/dev/null || true
  exit 1
fi
