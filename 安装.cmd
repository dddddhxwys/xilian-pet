@echo off
rem ============================================================
rem  Xilian Pet - one-click installer
rem
rem  Usage: double-click this file.
rem
rem  NOTE: This file is intentionally ASCII-ONLY, comments included.
rem        cmd.exe parses .cmd files with the OEM codepage (GBK on
rem        Chinese Windows); non-ASCII bytes here get mangled and can
rem        even leak out as bogus "commands". All user-facing Chinese
rem        is printed by Node instead.
rem
rem  It is safe to run more than once: every step is idempotent.
rem
rem  Everything printed here is also captured into install-log.txt
rem  next to this file, so a remote tester can send that one file.
rem ============================================================

rem Delayed expansion is required: inside the if(...) block below,
rem %ERRORLEVEL% / %CODE% would be expanded at PARSE time into empty
rem strings (seen in the wild: "[setup] FAILED (exit )" with no code).
setlocal enabledelayedexpansion
cd /d "%~dp0"

set "PET_LOG=%~dp0install-log.txt"

rem ------------------------------------------------------------
rem  Tee: re-run this script once with ALL output redirected into
rem  the log (including Node's own error output), then echo it back.
rem ------------------------------------------------------------
if not defined PET_TEE (
  set "PET_TEE=1"
  chcp 65001 >nul
  call "%~f0" %* > "%PET_LOG%" 2>&1
  set "CODE=!ERRORLEVEL!"
  type "%PET_LOG%"
  echo.
  if not "!CODE!"=="0" (
    echo [setup] FAILED ^(exit !CODE!^) - see the messages above.
  ) else (
    echo [setup] DONE - see "next steps" above.
  )
  echo [setup] Full log saved to: %PET_LOG%
  echo.
  rem only prompt+pause when double-clicked (no arguments)
  if "%~1"=="" (
    echo Press any key to close this window...
    pause >nul
  )
  exit /b !CODE!
)

rem ===== from here on: the real work (output is being captured) =====
chcp 65001 >nul

echo ==== xilian pet installer ====
echo time : %DATE% %TIME%
echo script: %~f0
echo cwd  : %CD%
echo.

set "PET_NODE="

rem ONE shared searcher for all three root .cmd files - see tools\find-node.cmd.
rem It checks, in order: Node shipped in this package, the DSH runtime under the
rem DSH home, the Node inside the DSH INSTALL directory (read from the uninstall
rem registry entry), then PATH. That install-directory step is why this became a
rem shared file: a tester had DSH installed AND running while the DSH home had no
rem runtime yet, and the old per-file search missed the copy inside the install.
rem
rem NOTE: do not add setlocal here or in find-node.cmd - the caller has to see
rem       the variable PET_NODE.
call "%~dp0tools\find-node.cmd"

if not defined PET_NODE (
  if not defined PET_DSH_HOME set "PET_DSH_HOME=%USERPROFILE%\.dsh"
  echo [ERROR] No Node runtime found on this machine.
  echo.
  echo   DSH home: %PET_DSH_HOME%
  if exist "%PET_DSH_HOME%" echo     - that folder exists
  if not exist "%PET_DSH_HOME%" echo     - that folder does NOT exist
  if exist "%PET_DSH_HOME%\dsh-runtimes" echo     - it HAS a dsh-runtimes folder, contents:
  if exist "%PET_DSH_HOME%\dsh-runtimes" dir /b "%PET_DSH_HOME%\dsh-runtimes"
  if not exist "%PET_DSH_HOME%\dsh-runtimes" echo     - it has NO dsh-runtimes folder yet
  echo.
  echo   The searcher also read the DSH install directory from the registry and
  echo   checked PATH - it found nothing anywhere. The lines above are only a
  echo   hint: an empty dsh-runtimes folder is NOT fatal by itself.
  echo.
  echo   Do this:
  echo     1. Start DSH once and let it fully open
  echo     2. Run this installer again
  echo.
  echo   Still failing? Send me install-log.txt - there is also a build that
  echo   ships its own Node and needs nothing from this machine.
  echo.
  echo   Nothing was changed on this machine.
  echo.
  exit /b 1
)

echo [setup] node: %PET_NODE%
echo.

"%PET_NODE%" "tools\setup.mjs" %*
exit /b !ERRORLEVEL!
