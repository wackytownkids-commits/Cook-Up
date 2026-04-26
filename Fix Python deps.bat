@echo off
REM Fix Python deps.bat - installs audiocraft's missing Python dependencies.
REM Double-click, wait a few minutes, then re-run Cookup.

cd /d "%~dp0"
title Cookup - Fix Python deps
color 0B
cls
echo =================================================
echo   Cookup - finishing Python setup
echo =================================================
echo.
echo Installing the deps audiocraft needs that I missed the first time.
echo This pulls in torchmetrics and a few others. Takes 2-5 minutes.
echo.

if not exist "python-runtime\python.exe" goto :no_runtime

python-runtime\python.exe -m pip install torchmetrics protobuf huggingface_hub tqdm omegaconf jsonschema torchcodec soundfile

if errorlevel 1 goto :failed

echo.
echo =================================================
echo   Done.
echo =================================================
echo Close this window and double-click Run Cookup.bat to try Cooking again.
pause
exit /b 0

:failed
echo.
echo Install failed. Copy the error above and paste it to Claude.
pause
exit /b 1

:no_runtime
echo Could not find python-runtime\python.exe
echo The first run of Run Cookup.bat has to finish the "Step 2: bundling
echo Python and MusicGen" step before this fix can run.
pause
exit /b 1
