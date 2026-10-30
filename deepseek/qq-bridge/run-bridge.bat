@echo off
setlocal
cd /d "%~dp0"
for %%I in ("%~dp0..") do set "DS_PROJECT=%%~fI"
set "DSH_HOME=%DS_PROJECT%\.dsh"
set "TEMP=%DS_PROJECT%\.tmp"
set "TMP=%TEMP%"
:loop
if exist "%~dp0.migration-in-progress" exit /b 0
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0cleanup-runtime.ps1" >> "%~dp0bridge.log" 2>&1
"%DS_PROJECT%\runtime\node\node.exe" "%~dp0bridge.mjs" >> "%~dp0bridge.log" 2>&1
ping 127.0.0.1 -n 6 >nul
goto loop
