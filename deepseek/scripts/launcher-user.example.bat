@echo off
setlocal DisableDelayedExpansion
cd /d "%~dp0" || exit /b 1
for %%I in ("%~dp0..\..") do set "DS_PROJECT=%%~fI"
set "TEMP=%DS_PROJECT%\.tmp"
set "TMP=%TEMP%"
set "APPDATA=%DS_PROJECT%\data\qq-user"
set "NAPCAT_PATCH_PACKAGE=%cd%\qqnt.json"
set "NAPCAT_LOAD_PATH=%cd%\loadNapCat.js"
set "NAPCAT_INJECT_PATH=%cd%\NapCatWinBootHook.dll"
set "NAPCAT_LAUNCHER_PATH=%cd%\NapCatWinBootMain.exe"
set "NAPCAT_MAIN_PATH=%cd%\napcat.mjs"
"%NAPCAT_LAUNCHER_PATH%" "%DS_PROJECT%\QQ\app\QQ.exe" "%NAPCAT_INJECT_PATH%" %*
