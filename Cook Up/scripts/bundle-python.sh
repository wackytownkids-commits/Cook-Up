#!/usr/bin/env bash
# Downloads a portable Python and installs Cookup's deps into it.
# The result (./python-runtime/) is bundled into Cookup.app so users
# never have to install Python themselves.
#
# Run from the project root:  bash scripts/bundle-python.sh

set -euo pipefail
cd "$(dirname "$0")/.."

# Latest stable python-build-standalone 3.11 release (Mac).
# python-build-standalone ships fully portable CPython tarballs.
PBS_VERSION="20240415"
PY_VERSION="3.11.9"

# Pick the right asset for the user's Mac.
ARCH="$(uname -m)"
case "$ARCH" in
  arm64)  TRIPLE="aarch64-apple-darwin" ;;
  x86_64) TRIPLE="x86_64-apple-darwin"  ;;
  *) echo "Unsupported Mac architecture: $ARCH"; exit 1 ;;
esac

ASSET="cpython-${PY_VERSION}+${PBS_VERSION}-${TRIPLE}-install_only.tar.gz"
URL="https://github.com/indygreg/python-build-standalone/releases/download/${PBS_VERSION}/${ASSET}"

WORK="build-python"
DEST="python-runtime"

mkdir -p "$WORK"
rm -rf "$DEST"

echo "Downloading portable Python ${PY_VERSION} for ${TRIPLE}..."
if [ ! -f "$WORK/$ASSET" ]; then
  curl -L -o "$WORK/$ASSET" "$URL"
fi

echo "Extracting..."
tar -xzf "$WORK/$ASSET" -C "$WORK"
mv "$WORK/python" "$DEST"

PY="$DEST/bin/python3"

echo "Upgrading pip..."
"$PY" -m pip install --upgrade pip wheel setuptools

echo "Installing PyTorch (Apple Silicon default wheel supports MPS)..."
"$PY" -m pip install "torch>=2.1" "torchaudio>=2.1"

echo "Installing audiocraft..."
"$PY" -m pip install "audiocraft>=1.3.0"

echo "Installing Flask..."
"$PY" -m pip install "flask>=3.0"

# Trim some weight - remove pip cache and tests.
find "$DEST" -type d -name "__pycache__" -prune -exec rm -rf {} +
find "$DEST" -type d -name "tests" -prune -exec rm -rf {} + 2>/dev/null || true
rm -rf "$DEST/lib/python3.11/site-packages/pip/_vendor/distlib/t32.exe" 2>/dev/null || true
rm -rf "$DEST/lib/python3.11/site-packages/pip/_vendor/distlib/t64.exe" 2>/dev/null || true

# Quick sanity check
"$PY" -c "import flask, torch, torchaudio, audiocraft; print('[bundle] all imports OK')"

echo ""
echo "python-runtime/ ready ($(du -sh "$DEST" | cut -f1)). Continue with: npm run dist:mac"
