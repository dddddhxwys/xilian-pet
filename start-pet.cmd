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
rem  NOTE: This file is intentionally ASCII-only. cmd.exe parses .cmd files
rem        with the OEM codepage (GBK on Chinese Windows), so UTF-8 Chinese
rem        text in here would be garbled. Chinese docs live in README.md.
rem ============================================================

chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PET_NODE=%USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe"
if not exist "%PET_NODE%" set "PET_NODE=node"

echo [start] node: %PET_NODE%
echo.

"%PET_NODE%" "packages\pet-shell\scripts\launch.mjs" %*

set "CODE=%ERRORLEVEL%"
if not "%CODE%"=="0" (
  echo.
  echo [exit code %CODE%] Something failed - see the log above.
  pause
)
endlocal
