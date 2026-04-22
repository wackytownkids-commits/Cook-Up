#!/usr/bin/env bash
# Cookup - one-shot setup script (Mac/Linux).
# Creates a Python virtualenv in .venv and installs audiocraft + friends.
# After this: `npm install && npm start`.
#
# Requirements: Python 3.10 or 3.11 (audiocraft is picky; avoid 3.12+ for now).

set -e

cd "$(dirname "$0")"

if ! command -v python3 >/dev/null 2>&1; then
  echo "python3 not found. Install Python 3.10 or 3.11 from python.org, then re-run."
  exit 1
fi

PY_VER=$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
echo "Using Python $PY_VER"

case "$PY_VER" in
  3.10|3.11) ;;
  *) echo "!! audiocraft works best on Python 3.10 or 3.11 (you have $PY_VER). Continuing anyway.";;
esac

if [ ! -d .venv ]; then
  echo "Creating virtualenv in .venv ..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate

echo "Upgrading pip ..."
python -m pip install --upgrade pip wheel setuptools

echo "Installing PyTorch (Apple Silicon uses the default wheel + MPS) ..."
pip install "torch>=2.1" "torchaudio>=2.1"

echo "Installing audiocraft (MusicGen) ..."
pip install "audiocraft>=1.3.0"

echo "Installing Flask ..."
pip install "flask>=3.0"

echo "Downloading MusicGen-Melody weights (~2GB, one-time) ..."
python - <<'PY'
from audiocraft.models import MusicGen
print("Fetching facebook/musicgen-melody ... this runs once, then it's cached.")
MusicGen.get_pretrained("facebook/musicgen-melody", device="cpu")
print("Weights cached.")
PY

echo ""
echo "Cookup is set up."
echo "Next:"
echo "  npm install"
echo "  npm start"
