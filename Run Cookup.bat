@echo off
REM Run Cookup.bat - Windows one-click launcher.
REM Double-click this to launch Cookup on your PC.
REM First run installs Node deps and bundles Python + MusicGen.
REM Later runs start Cookup in ~5 seconds.

setlocal EnableDelayedExpansion
cd /d "%~dp0"

title Cookup
color 0B
cls
echo =================================================
echo                    Cookup
echo =================================================
echo Don't close this window while Cookup is running.
echo Close the window to quit Cookup.
echo =================================================
echo.

REM --- 0. Kill any orphan Cookup/Python processes from a previous run.
REM Stops "stale server" bugs where the old code is still loaded in memory.
taskkill /F /IM Cookup.exe >nul 2>&1
taskkill /F /IM electron.exe >nul 2>&1
REM Only kill python that came from our bundled runtime (same folder).
for /f "tokens=2 delims=," %%i in ('wmic process where "name='python.exe' and ExecutablePath like '%%Cook Up%%python-runtime%%'" get ProcessId /format:csv 2^>nul ^| findstr /r "[0-9]"') do (
    taskkill /F /PID %%i >nul 2>&1
)
timeout /t 1 /nobreak >nul

REM --- 1. Check Node.js ---
where node >nul 2>&1
if errorlevel 1 goto :no_node

for /f "delims=" %%v in ('node --version') do set NODE_VER=%%v
echo [ok] Node.js found: !NODE_VER!

REM --- 2. npm install ---
if exist "node_modules\" goto :skip_npm_install
echo.
echo Step 1 of 3: installing Electron dependencies...
call npm install
if errorlevel 1 goto :npm_failed
goto :after_npm_install

:skip_npm_install
echo [ok] Electron deps already installed.

:after_npm_install

REM --- 3. bundle portable Python + MusicGen ---
if exist "python-runtime\python.exe" goto :skip_bundle
echo.
echo Step 2 of 3: bundling Python and MusicGen. This is the slow one, about 15 minutes.
powershell -ExecutionPolicy Bypass -File "scripts\bundle-python.ps1"
if errorlevel 1 goto :bundle_failed
goto :launch_cookup

:skip_bundle
echo [ok] python-runtime\ already bundled.

:launch_cookup
echo.
echo Step 3 of 3: launching Cookup...
echo.
echo Cookup's window should appear in a moment.
echo Leave this window open while you use Cookup. Close this window to quit.
echo.
call npm start
goto :end

:no_node
echo Node.js is not installed, or was just installed and this session
echo has not picked up the updated PATH yet.
echo.
echo If you JUST installed Node.js:
echo    1. Close this window
echo    2. Sign out of Windows and sign back in, then try again.
echo.
echo If you have NOT installed Node.js, the download page will open now.
echo    1. Click the big green LTS button
echo    2. Run the installer, click through defaults
echo    3. Sign out of Windows and sign back in
echo    4. Double-click Run Cookup.bat again
echo.
start "" "https://nodejs.org/en/download/"
pause
exit /b 1

:npm_failed
echo.
echo npm install failed. Scroll up to see the error.
pause
exit /b 1

:bundle_failed
echo.
echo Python bundle failed. Scroll up to see the error.
pause
exit /b 1

:end
endlocal
