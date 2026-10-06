@echo off
rem ============================================================
rem  Xilian Pet - find a Node runtime (SHARED by every root .cmd)
rem
rem  Usage from a root-level .cmd:
rem      set "PET_NODE="
rem      call "%~dp0tools\find-node.cmd"
rem      if not defined PET_NODE ( ...print your own message... exit /b 1 )
rem
rem  Sets PET_NODE to an absolute node.exe path, or leaves it undefined
rem  (and prints the searched locations). It does NOT call setlocal on
rem  purpose: the caller must see the variable. It never changes the
rem  current directory.
rem
rem  WHY THIS FILE EXISTS
rem    1. The three root .cmd files used to each carry their own copy of
rem       this search. That already caused a real bug once (a location was
rem       added to one file and forgotten in another), so it is one file now.
rem    2. The search used to MISS the DSH installation directory. A tester
rem       had DSH installed AND running, yet %USERPROFILE%\.dsh\dsh-runtimes
rem       was still empty - and the installer failed with "NO dsh-runtimes
rem       folder yet" on a machine that did have a perfectly good Node at
rem       DSH-install\resources\runtime\*\dependencies\node\bin\node.exe.
rem       That directory is found through the per-user uninstall registry
rem       entry (HKCU first, then HKLM for all-users installs).
rem
rem  NOTE: This file is intentionally ASCII-ONLY, comments included.
rem        cmd.exe parses .cmd files with the OEM codepage (GBK on
rem        Chinese Windows); non-ASCII bytes here get mangled and can
rem        even leak out as bogus "commands".
rem ============================================================

set "PET_NODE="
set "PET_ROOT=%~dp0.."

rem 0) Node shipped INSIDE this package (the all-in-one build has one).
rem    Checked first: most predictable, needs no prerequisites at all.
for %%P in (
  "%PET_ROOT%\node\node.exe"
  "%PET_ROOT%\tools\node\node.exe"
  "%PET_ROOT%\vendor\node\node.exe"
) do (
  if exist "%%~fP" if not defined PET_NODE set "PET_NODE=%%~fP"
)

rem 1) DSH's runtime as unpacked under the DSH home.
rem    IMPORTANT: DSH unpacks this on its FIRST LAUNCH - installing DSH is
rem    not enough, so a tester who "already installed DSH" can still have no
rem    runtime here. That is why step 2 exists.
set "PET_DSH_HOME=%USERPROFILE%\.dsh"
if defined DSH_HOME set "PET_DSH_HOME=%DSH_HOME%"
for /d %%D in ("%PET_DSH_HOME%\dsh-runtimes\*") do (
  if not defined PET_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "PET_NODE=%%~fD\dependencies\node\bin\node.exe"
)
for /d %%D in ("%PET_DSH_HOME%\dsh-runtimes\*") do (
  if not defined PET_NODE if exist "%%~fD\dependencies\node\node.exe" set "PET_NODE=%%~fD\dependencies\node\node.exe"
)
rem a couple of other layouts seen in the wild
for /d %%D in ("%PET_DSH_HOME%\dsh-runtimes\*\dependencies\node*") do (
  if not defined PET_NODE if exist "%%~fD\bin\node.exe" set "PET_NODE=%%~fD\bin\node.exe"
)

rem 2) Node shipped INSIDE the DSH installation itself.
rem    Read the install directory from the uninstall registry entry - do NOT
rem    guess common paths, because DSH can be installed anywhere (seen on a
rem    machine installed to F:\dsh).
rem
rem    CMD TRAP - the `for /d` loop below MUST stay a SEPARATE statement from
rem    the block that sets PET_DSH_INSTALL. Inside one parenthesised block, cmd
rem    expands %PET_DSH_INSTALL% when it PARSES the block - i.e. while the
rem    variable is still empty - so the scan silently searched "\resources\..."
rem    instead. Measured: the variable was correctly found as F:\dsh while the
rem    scan still failed. Delayed expansion (!VAR!) is not an option here: this
rem    file is called by launchers that do not all enable it.
set "PET_DSH_INSTALL="
if not defined PET_NODE (
  for %%H in (
    "HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    "HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
  ) do (
    if not defined PET_DSH_INSTALL (
      for /f "delims=" %%K in ('reg query %%H /s /f "DeepSeek Harness" /d 2^>nul ^| findstr /r /i "^HKEY_"') do (
        if not defined PET_DSH_INSTALL (
          for /f "tokens=2,*" %%A in ('reg query "%%K" /v InstallLocation 2^>nul ^| findstr /r /i "^ *InstallLocation"') do (
            if exist "%%B\resources\runtime" set "PET_DSH_INSTALL=%%B"
          )
        )
      )
    )
  )
)
if not defined PET_NODE if defined PET_DSH_INSTALL (
  for /d %%D in ("%PET_DSH_INSTALL%\resources\runtime\*") do (
    if not defined PET_NODE if exist "%%~fD\dependencies\node\bin\node.exe" set "PET_NODE=%%~fD\dependencies\node\bin\node.exe"
    if not defined PET_NODE if exist "%%~fD\dependencies\node\node.exe" set "PET_NODE=%%~fD\dependencies\node\node.exe"
  )
)

rem 3) node on PATH
if not defined PET_NODE (
  for %%N in (node.exe) do if not "%%~$PATH:N"=="" set "PET_NODE=%%~$PATH:N"
)

if not defined PET_NODE (
  echo [node] no Node runtime found. Locations checked:
  echo.
  echo   %PET_ROOT%\node\node.exe            ^(all-in-one package^)
  echo   %PET_DSH_HOME%\dsh-runtimes\*\dependencies\node\bin\node.exe
  echo   DSH install dir\resources\runtime\*\dependencies\node\bin\node.exe
  echo   PATH: node.exe
  echo.
  rem These two lines exist for remote support: they say whether we even FOUND
  rem the DSH installation, which is what tells the two failure modes apart.
  if defined PET_DSH_INSTALL echo   DSH install found at %PET_DSH_INSTALL% - but no runtime under it.
  if not defined PET_DSH_INSTALL echo   No DSH uninstall entry with an InstallLocation was found.
  echo.
)

exit /b 0
