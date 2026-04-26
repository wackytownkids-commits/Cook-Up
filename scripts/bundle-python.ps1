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

Write-Host "Installing audiocraft (no deps - we install them explicitly below)..."
& $Py -m pip install "audiocraft>=1.3.0" --no-deps

Write-Host "Installing audiocraft's full dependency set..."
& $Py -m pip install `
    av einops flashy hydra-core hydra-colorlog julius num2words `
    numpy sentencepiece spacy transformers huggingface_hub tqdm `
    librosa soundfile demucs encodec torchmetrics protobuf `
    omegaconf jsonschema

Write-Host "Installing torchcodec (newer torchaudio uses this for save)..."
& $Py -m pip install torchcodec

Write-Host "Installing Flask (for Cookup's local server)..."
& $Py -m pip install "flask>=3.0"

Write-Host "Installing xformers (audiocraft imports this unconditionally)..."
$xfokay = $false
try {
    & $Py -m pip install xformers 2>$null
    if ($LASTEXITCODE -eq 0) { $xfokay = $true }
} catch {}
if (-not $xfokay) {
    Write-Host "  xformers wheel unavailable for this Python/torch combo."
    Write-Host "  Writing a stub module so audiocraft imports succeed and falls"
    Write-Host "  back to PyTorch native attention."
    $xf = Join-Path $Dest "Lib\site-packages\xformers"
    New-Item -ItemType Directory -Force -Path $xf | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $xf "ops") | Out-Null
    New-Item -ItemType Directory -Force -Path (Join-Path $xf "components") | Out-Null
    Set-Content (Join-Path $xf "__init__.py") '__version__ = "0.0.0-stub"'
    Set-Content (Join-Path $xf "ops\__init__.py") 'def memory_efficient_attention(*a, **k):' "`n    raise NotImplementedError(""xformers stubbed - audiocraft uses native attention"")"
    Set-Content (Join-Path $xf "components\__init__.py") ''
    Set-Content (Join-Path $xf "components\attention.py") @'
class Attention:
    def __init__(self, *a, **k):
        raise NotImplementedError()
class AttentionMask:
    def __init__(self, *a, **k):
        raise NotImplementedError()
'@
    Write-Host "  Stub xformers module created at $xf"
}

Write-Host "Trimming cache..."
Get-ChildItem -Path $Dest -Recurse -Directory -Filter "__pycache__" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
Get-ChildItem -Path $Dest -Recurse -Directory -Filter "tests" | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue

Write-Host "Sanity check..."
& $Py -c "import flask, torch, torchaudio, audiocraft, soundfile; print('[bundle] all imports OK')"

Write-Host ""
Write-Host "python-runtime\ ready. Continue with: npm run dist:win"
