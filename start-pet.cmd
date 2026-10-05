@echo off
rem ============================================================
rem  Xilian desktop pet - one-click launcher
rem
rem  Usage: double-click this file, or run  start-pet.cmd  in a terminal
rem         add  --check  to only run the environment self-check (no window)
rem
rem  How to QUIT the pet:
rem     The pet window is frameless and hidden from the taskbar.
rem     Press  Ctrl+Shift+Q  to quit (global shortcut registered by the launcher).
rem     Closing this console window also stops the pet.
rem
rem  NOTE: This file is intentionally ASCII-ONLY, comments included.
rem        cmd.exe parses .cmd files with the OEM codepage (GBK on
rem        Chinese Windows); non-ASCII bytes here get mangled and can even
rem        leak out as bogus "commands". Chinese docs live in README.md.
rem ============================================================

chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PET_NODE="

rem 0) Node shipped INSIDE this package (the "all-in-one" build has one)
rem    keeps the launcher working with zero prerequisites
for %%P in (
  "%~dp0node\node.exe"
  "%~dp0tools\node\node.exe"
) do (
  if exist "%%~fP" if not defined PET_NODE set "PET_NODE=%%~fP"
)

rem 1) DSH's own bundled runtime (unpacked on the first launch of DSH)
if not defined PET_NODE (
  for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
    if exist "%%~fD\dependencies\node\bin\node.exe" set "PET_NODE=%%~fD\dependencies\node\bin\node.exe"
  )
)

rem 2) node on PATH
if not defined PET_NODE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "PET_NODE=%%~$PATH:N"
)

if not defined PET_NODE (
  echo [ERROR] No Node runtime found - cannot start the pet.
  echo.
  echo   Run the installer first ^(the other .cmd file in this folder^):
  echo   it sets everything up and reports whatever is missing.
  echo.
  if "%~1"=="" pause
  exit /b 1
)

echo [start] node: %PET_NODE%
echo.

"%PET_NODE%" "packages\pet-shell\scripts\launch.mjs" %*

set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [exit code %CODE%] Something failed - see the log above.
  if "%~1"=="" pause
)
endlocal
