# bundle-python.ps1
# Windows equivalent of bundle-python.sh.
# Downloads a portable Python (x64) and installs Cookup's Python deps into it.
# The result (./python-runtime/) gets bundled into Cookup-Setup.exe.

$ErrorActionPreference = "Stop"
Set-Location (Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path))

$PbsVersion = "20240415"
$PyVersion = "3.11.9"
$Asset = "cpython-$PyVersion+$PbsVersion-x86_64-pc-windows-msvc-install_only.tar.gz"
$Url = "https://github.com/indygreg/python-build-standalone/releases/download/$PbsVersion/$Asset"

$Work = "build-python"
$Dest = "python-runtime"

New-Item -ItemType Directory -Force -Path $Work | Out-Null
if (Test-Path $Dest) { Remove-Item -Recurse -Force $Dest }

$Tarball = Join-Path $Work $Asset
if (-not (Test-Path $Tarball)) {
    Write-Host "Downloading portable Python $PyVersion for Windows..."
    Invoke-WebRequest -Uri $Url -OutFile $Tarball
}

Write-Host "Extracting..."
tar -xzf $Tarball -C $Work
Move-Item (Join-Path $Work "python") $Dest

$Py = Join-Path $Dest "python.exe"

Write-Host "Upgrading pip..."
& $Py -m pip install --upgrade pip wheel setuptools

Write-Host "Installing PyTorch (CPU build for portability)..."
& $Py -m pip install "torch>=2.1" "torchaudio>=2.1" --index-url https://download.pytorch.org/whl/cpu

Write-Host "Installing audiocraft..."
# audiocraft pulls xformers which has no stable Windows wheel.
# Install audiocraft without deps, then its deps except xformers.
& $Py -m pip install "audiocraft>=1.3.0" --no-deps
& $Py -m pip install av einops flashy hydra-core hydra-colorlog julius num2words `
    numpy sentencepiece spacy transformers "pesq; platform_system!='Windows'" `
    librosa soundfile demucs encodec

Write-Host "Installing Flask..."
& $Py -m pip install "flask>=3.0"

Write-Host "Trimming cache..."
Get-ChildItem -Path $Dest -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $Dest -Recurse -Directory -Filter "tests" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Sanity check..."
& $Py -c "import flask, torch, torchaudio, audiocraft; print('[bundle] all imports OK')"

Write-Host ""
Write-Host "python-runtime\ ready. Continue with: npm run dist:win"
