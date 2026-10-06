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

rem ONE shared searcher for all three root .cmd files - see tools\find-node.cmd.
rem (Package node, DSH home runtime, Node inside the DSH INSTALL directory,
rem  then PATH.) It must not be inlined here again: three copies of this search
rem is what let a location go missing in one of them.
call "%~dp0tools\find-node.cmd"

rem Running from inside the zip: find-node.cmd already explained it.
if defined PET_ZIP_RUN (
  if "%~1"=="" pause
  exit /b 1
)

if not defined PET_NODE (
  echo [ERROR] No Node runtime found - cannot start the pet.
  echo.
  echo   Run the installer first ^(the other .cmd file in this folder^):
  echo   it sets everything up and reports whatever is missing.
  echo   If you already ran it successfully, send me install-log.txt.
  echo.
  if "%~1"=="" pause
  exit /b 1
)

echo [start] node: %PET_NODE%
echo.

rem --hit-debug: log one line per second with cursor / window / mask coordinates and
rem the sampled alpha. This is how "only part of her can be dragged" gets pinned down
rem (the line shows exactly which part the hit test considers transparent).
if "%~1"=="--hit-debug" (
  set "PET_HIT_DEBUG=1"
  echo [start] hit-debug ON - details go into packages\pet-shell\.state\pet.log
  echo.
)

"%PET_NODE%" "packages\pet-shell\scripts\launch.mjs" %*

set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [exit code %CODE%] Something failed - see the log above.
  if "%~1"=="" pause
)
endlocal
