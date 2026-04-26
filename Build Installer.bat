@echo off
REM Build Installer.bat - produces Cookup-Setup-0.1.0.exe on Windows.
REM Double-click this. It uses your existing python-runtime\ if present,
REM so after your first successful Run Cookup.bat this is fast (~3 min).
REM From scratch (fresh PC, no python-runtime yet) it's ~20-25 min.

cd /d "%~dp0"
title Cookup - Build Installer
color 0B
cls
echo =================================================
echo   Building Cookup-Setup.exe
echo =================================================
echo.
echo This produces dist\Cookup-Setup-0.1.0.exe - a normal Windows installer
echo you can share with friends. They double-click it, Cookup installs to
echo Start Menu, launches like any other app (no black Command Prompt).
echo.
echo First run from a fresh PC: ~20 minutes (bundles Python + MusicGen).
echo If you already cooked a beat once, the Python bundle is cached and
echo this takes 3-5 minutes.
echo.

where node >nul 2>&1
if errorlevel 1 goto :no_node

if not exist "node_modules\" (
    echo Installing Electron build tools...
    call npm install
    if errorlevel 1 goto :npm_failed
)

if not exist "python-runtime\python.exe" (
    echo.
    echo Step 1 of 2: bundling Python and audiocraft ^(slow, ~15 min^)...
    powershell -ExecutionPolicy Bypass -File "scripts\bundle-python.ps1"
    if errorlevel 1 goto :bundle_failed
) else (
    echo [ok] python-runtime\ already bundled - reusing it.
)

echo.
echo Step 2 of 2: running electron-builder ^(~3-5 min^)...
REM Skip code-signing auto-detection which fails without a real cert
REM and triggers the "spawn UNKNOWN" error on some Windows setups.
set CSC_IDENTITY_AUTO_DISCOVERY=false
set WIN_CSC_LINK=
set WIN_CSC_KEY_PASSWORD=
call npx electron-builder --win
if errorlevel 1 goto :build_failed

echo.
echo =================================================
echo   Done.
echo =================================================
echo Your installer: dist\Cookup-Setup-0.1.0.exe
echo Opening the dist folder in File Explorer now...
echo.
start "" explorer "%~dp0dist"
pause
exit /b 0

:no_node
echo Node.js is not installed.
echo Install from nodejs.org, then re-run this.
start "" "https://nodejs.org/en/download/"
pause
exit /b 1

:npm_failed
echo npm install failed. Scroll up for the error.
pause
exit /b 1

:bundle_failed
echo Python bundle failed. Scroll up for the error.
pause
exit /b 1

:build_failed
echo electron-builder failed. Scroll up for the error.
pause
exit /b 1
