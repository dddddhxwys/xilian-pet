@echo off
rem ============================================================
rem  Xilian Pet - one-click installer
rem
rem  Usage: double-click this file.
rem
rem  NOTE: This file is intentionally ASCII-only.
rem        cmd.exe parses .cmd files with the OEM codepage (GBK on
rem        Chinese Windows), so UTF-8 Chinese text in here would be
rem        garbled. All Chinese messages are printed by Node instead
rem        (see tools/setup.mjs).
rem
rem  It is safe to run more than once: every step is idempotent.
rem
rem  Everything this script prints is also captured into
rem  install-log.txt next to it - so a remote tester can just send
rem  that one file instead of a screenshot.
rem ============================================================
setlocal
cd /d "%~dp0"

set "PET_LOG=%~dp0install-log.txt"

rem ------------------------------------------------------------
rem  Tee: re-run this script once with ALL output redirected into
rem  the log (including Node's own error output), then echo it back.
rem  Without this, a failure before Node starts leaves no trace at
rem  all - the tester is left with a window that says nothing.
rem ------------------------------------------------------------
if not defined PET_TEE (
  set "PET_TEE=1"
  chcp 65001 >nul
  call "%~f0" %* > "%PET_LOG%" 2>&1
  set "CODE=%ERRORLEVEL%"
  type "%PET_LOG%"
  echo.
  if not "%CODE%"=="0" (
    echo [setup] FAILED ^(exit %CODE%^) - see the messages above.
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
  exit /b %CODE%
)

rem ===== from here on: the real work (output is being captured) =====
chcp 65001 >nul

echo ==== xilian pet installer ====
echo time : %DATE% %TIME%
echo script: %~f0
echo cwd  : %CD%
echo.

set "PET_NODE="

rem 1) DSH ships its own Node runtime - prefer it (always present on a machine with DSH)
for /d %%D in ("%USERPROFILE%\.dsh\dsh-runtimes\*") do (
  if exist "%%~fD\dependencies\node\bin\node.exe" set "PET_NODE=%%~fD\dependencies\node\bin\node.exe"
)

rem 2) fall back to node on PATH
if not defined PET_NODE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "PET_NODE=%%~$PATH:N"
)

if not defined PET_NODE (
  echo [ERROR] Could not find a Node runtime.
  echo         - If DSH is installed, start it once so its runtime is unpacked.
  echo         - Otherwise install Node.js 20 or newer.
  echo.
  exit /b 1
)

echo [setup] node: %PET_NODE%
echo.

"%PET_NODE%" "tools\setup.mjs" %*
exit /b %ERRORLEVEL%
