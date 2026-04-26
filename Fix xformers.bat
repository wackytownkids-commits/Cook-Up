@echo off
REM Fix xformers.bat - installs the missing xformers module into Cookup's
REM bundled Python so audiocraft stops crashing on Windows.
REM Double-click once, wait about a minute, then re-run Cookup.

cd /d "%~dp0"
title Cookup - xformers fix
color 0B
cls
echo =================================================
echo   Cookup - Windows xformers fix
echo =================================================
echo.
echo This installs the missing xformers module into Cookup's bundled Python.
echo Takes about a minute. You'll see pip output scroll by.
echo.

if not exist "python-runtime\python.exe" goto :no_runtime

echo Attempt 1: install latest xformers from PyPI...
python-runtime\python.exe -m pip install xformers
if not errorlevel 1 goto :success

echo.
echo Attempt 2: older version with broader Windows wheel support...
python-runtime\python.exe -m pip install "xformers==0.0.23"
if not errorlevel 1 goto :success

echo.
echo Attempt 3: both failed - writing a stub module that lets audiocraft fall
echo back to PyTorch's native attention (a little slower but works everywhere)...
python-runtime\python.exe -c "import os,sys; base=os.path.join('python-runtime','Lib','site-packages','xformers'); os.makedirs(os.path.join(base,'ops'), exist_ok=True); os.makedirs(os.path.join(base,'components'), exist_ok=True); open(os.path.join(base,'__init__.py'),'w').write('__version__=\"0.0.0-stub\"\n'); open(os.path.join(base,'ops','__init__.py'),'w').write('def memory_efficient_attention(*a, **k):\n    raise NotImplementedError(\"xformers stubbed - audiocraft should use native attention\")\n'); open(os.path.join(base,'components','__init__.py'),'w').write(''); open(os.path.join(base,'components','attention.py'),'w').write('class Attention:\n    def __init__(self,*a,**k): raise NotImplementedError()\n\nclass AttentionMask:\n    def __init__(self,*a,**k): raise NotImplementedError()\n'); print('[ok] stub created at', base)"
if not errorlevel 1 goto :success

echo.
echo All three approaches failed. Tell Claude so we can try a different fix.
pause
exit /b 1

:success
echo.
echo =================================================
echo   Fix applied.
echo =================================================
echo Close this window, then double-click Run Cookup.bat again.
echo.
pause
exit /b 0

:no_runtime
echo Could not find python-runtime\python.exe
echo The first run of Run Cookup.bat must finish the "Step 2 of 3: bundling
echo Python and MusicGen" step before this fix script can run.
pause
exit /b 1
