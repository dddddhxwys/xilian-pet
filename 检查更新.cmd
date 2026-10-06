@echo off
rem ============================================================
rem  Xilian Pet - check for updates
rem
rem  Usage: double-click this file, or run it in a terminal.
rem
rem  It reads your local version (VERSION.txt from a release zip, or
rem  package.json when run from the repo) and asks the published
rem  manifest whether a newer release exists.
rem
rem  It is READ-ONLY: it never downloads the release, never replaces
rem  files, and never touches the DSH profile. Worst case it prints
rem  something you did not need.
rem
rem  Exit codes: 0 = up to date, 10 = update available, 1 = check failed
rem
rem  NOTE: This file is intentionally ASCII-ONLY, comments included.
rem        cmd.exe parses .cmd files with the OEM codepage (GBK on
rem        Chinese Windows); non-ASCII bytes here get mangled and can
rem        even leak out as bogus "commands". All Chinese output is
rem        printed by Node instead.
rem ============================================================
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PET_NODE="

rem ONE shared searcher for all three root .cmd files - see tools\find-node.cmd.
rem (Package node, DSH home runtime, Node inside the DSH INSTALL directory,
rem  then PATH.) Do not inline a copy here: three copies is how a location
rem went missing in one of them once already.
call "%~dp0tools\find-node.cmd"

rem Running from inside the zip: find-node.cmd already explained it.
if defined PET_ZIP_RUN (
  if "%~1"=="" pause
  exit /b 1
)

if not defined PET_NODE (
  echo [ERROR] No Node runtime found - cannot check for updates.
  echo.
  echo   Start DSH once - it unpacks its runtime on the first launch -
  echo   then run this file again. If DSH is already running, send me
  echo   install-log.txt from the installer instead.
  echo   Nothing was changed on this machine.
  if "%~1"=="" pause
  exit /b 1
)

chcp 65001 >nul
"%PET_NODE%" "tools\check-update.mjs" %*
set "CODE=!ERRORLEVEL!"

rem with arguments this is being scripted: pass the exit code through untouched
if not "%~1"=="" exit /b !CODE!

echo.
if "!CODE!"=="10" (
  echo [check] An update is available - see the download link above.
) else if "!CODE!"=="0" (
  echo [check] You are up to date.
) else (
  echo [check] Could not check ^(exit !CODE!^) - this does NOT mean you are up to date.
)
echo.
echo Press any key to close this window...
pause >nul
exit /b !CODE!
