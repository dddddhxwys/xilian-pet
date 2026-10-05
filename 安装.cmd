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

rem 0) a Node runtime shipped INSIDE this package (the "full" package has one)
rem    -> checked first: most predictable, and needs no prerequisites at all
for %%P in (
  "%~dp0node\node.exe"
  "%~dp0tools\node\node.exe"
  "%~dp0vendor\node\node.exe"
) do (
  if exist "%%~fP" if not defined PET_NODE set "PET_NODE=%%~fP"
)

rem 1) DSH's own bundled Node runtime.
rem    IMPORTANT: DSH unpacks this on its FIRST LAUNCH - installing DSH is
rem    not enough, so a tester who "already installed DSH" can still have no
rem    runtime here. That is why the error message below distinguishes the
rem    two cases.
set "DSH_HOME_DIR=%USERPROFILE%\.dsh"
if defined DSH_HOME set "DSH_HOME_DIR=%DSH_HOME%"
for /d %%D in ("%DSH_HOME_DIR%\dsh-runtimes\*") do (
  if not defined PET_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "PET_NODE=%%~fD\dependencies\node\bin\node.exe"
)
rem a couple of other layouts seen in the wild
for /d %%D in ("%DSH_HOME_DIR%\dsh-runtimes\*") do (
  if not defined PET_NODE if exist "%%~fD\dependencies\node\node.exe" set "PET_NODE=%%~fD\dependencies\node\node.exe"
)
for /d %%D in ("%DSH_HOME_DIR%\dsh-runtimes\*\dependencies\node*") do (
  if not defined PET_NODE if exist "%%~fD\bin\node.exe" set "PET_NODE=%%~fD\bin\node.exe"
)

rem 2) fall back to node on PATH
if not defined PET_NODE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "PET_NODE=%%~$PATH:N"
)

if not defined PET_NODE (
  echo [ERROR] No Node runtime found on this machine.
  echo.
  if exist "%DSH_HOME_DIR%" (
    echo   The DSH folder EXISTS: %DSH_HOME_DIR%
    echo   ...but it has no Node runtime yet.
    echo.
    echo   DSH unpacks its runtime on the FIRST LAUNCH. Installing DSH is
    echo   not enough - it has to actually start once.
    echo.
    echo   Do this:
    echo     1. Start DSH once and let it fully open
    echo     2. Run this installer again
  ) else (
    echo   There is no DSH folder either: %DSH_HOME_DIR%
    echo.
    echo   Pick ONE of these:
    echo     1. Install DSH and start it once   ^(recommended: the pet follows DSH^)
    echo     2. Install Node.js 20 or newer
    echo     3. Ask for the "full" package, which ships its own Node
  )
  echo.
  echo   Nothing was changed on this machine.
  echo.
  echo   Locations checked ^(send this list back if your DSH lives elsewhere^):
  echo     %~dp0node\node.exe
  echo     %DSH_HOME_DIR%\dsh-runtimes\*\dependencies\node\bin\node.exe
  echo     %DSH_HOME_DIR%\dsh-runtimes\*\dependencies\node\node.exe
  echo     PATH: node.exe
  echo.
  exit /b 1
)

echo [setup] node: %PET_NODE%
echo.

"%PET_NODE%" "tools\setup.mjs" %*
exit /b !ERRORLEVEL!
