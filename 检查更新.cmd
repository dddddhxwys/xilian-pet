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

rem 0) Node shipped INSIDE this package (the all-in-one build has one)
for %%P in (
  "%~dp0node\node.exe"
  "%~dp0tools\node\node.exe"
  "%~dp0vendor\node\node.exe"
) do (
  if exist "%%~fP" if not defined PET_NODE set "PET_NODE=%%~fP"
)

rem 1) DSH's own bundled runtime (DSH unpacks it on its FIRST launch)
set "DSH_HOME_DIR=%USERPROFILE%\.dsh"
if defined DSH_HOME set "DSH_HOME_DIR=%DSH_HOME%"
for /d %%D in ("%DSH_HOME_DIR%\dsh-runtimes\*") do (
  if not defined PET_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "PET_NODE=%%~fD\dependencies\node\bin\node.exe"
)
for /d %%D in ("%DSH_HOME_DIR%\dsh-runtimes\*") do (
  if not defined PET_NODE if exist "%%~fD\dependencies\node\node.exe" set "PET_NODE=%%~fD\dependencies\node\node.exe"
)

rem 2) node on PATH
if not defined PET_NODE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "PET_NODE=%%~$PATH:N"
)

if not defined PET_NODE (
  echo [ERROR] No Node runtime found - cannot check for updates.
  echo.
  echo   Checked these locations:
  echo     %~dp0node\node.exe
  echo     %DSH_HOME_DIR%\dsh-runtimes\*\dependencies\node\bin\node.exe
  echo     PATH: node.exe
  echo.
  echo   Start DSH once - it unpacks its runtime on the first launch -
  echo   then run this file again.
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
