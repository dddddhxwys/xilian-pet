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
rem ============================================================

chcp 65001 >nul
setlocal
cd /d "%~dp0"

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
  echo         Start DSH once, or install Node.js 20 or newer.
  echo.
  rem only pause when double-clicked (no arguments) - so scripts can call us
  if "%~1"=="" pause
  exit /b 1
)

echo [setup] node: %PET_NODE%
echo.

"%PET_NODE%" "tools\setup.mjs" %*
set "CODE=%ERRORLEVEL%"

echo.
if not "%CODE%"=="0" echo [setup] finished with errors ^(exit %CODE%^). See the messages above.
rem only pause when double-clicked (no arguments) - so scripts can call us
if "%~1"=="" pause
exit /b %CODE%
