# Create/replace the desktop shortcut for the pet, and place the launcher icon at an
# ASCII-only path.
#
# Why the ASCII rule: Windows resolves a shortcut icon through the legacy icon API, and if
# the IconLocation contains non-ASCII characters the icon is drawn as a blank page.
# Measured 2026-11-08: the SAME .ico renders fine from C:\Users\Public and fails from a
# path containing CJK (while LoadImage/ExtractIconEx read it fine either way).
#
# ASCII-only on purpose: Windows PowerShell 5.1 decodes a BOM-less .ps1 as ANSI/GBK, so any
# non-ASCII byte in this file would be garbled (and could even turn into bogus code).
# All Chinese text (link name, paths) arrives as arguments, which are passed as Unicode.
param(
  [Parameter(Mandatory = $true)][string]$SourceIcon,
  [Parameter(Mandatory = $true)][string]$IconDest,
  [Parameter(Mandatory = $true)][string]$Target,
  [Parameter(Mandatory = $true)][string]$LinkName
)

$ErrorActionPreference = 'Stop'

# --- 1) guards ------------------------------------------------------------
if ($IconDest -match '[^\x20-\x7E]') {
  throw ("IconDest contains non-ASCII characters, Windows would draw a blank icon: " + $IconDest)
}
if (-not (Test-Path -LiteralPath $SourceIcon)) { throw ("SourceIcon missing: " + $SourceIcon) }
if (-not (Test-Path -LiteralPath $Target)) { throw ("Target missing: " + $Target) }

# --- 2) place the icon ----------------------------------------------------
$iconDir = Split-Path -Parent $IconDest
New-Item -ItemType Directory -Force -Path $iconDir | Out-Null
Copy-Item -LiteralPath $SourceIcon -Destination $IconDest -Force
Write-Output ("icon  : " + $IconDest + "  (" + (Get-Item -LiteralPath $IconDest).Length + " B)")

# --- 3) build the shortcut on the real Desktop ----------------------------
# GetFolderPath handles a OneDrive-redirected Desktop; hard-coding <home>\Desktop does not.
$desktop = [Environment]::GetFolderPath('Desktop')
if (-not $desktop -or -not (Test-Path -LiteralPath $desktop)) { throw 'Desktop folder not found' }
$linkPath = Join-Path $desktop $LinkName

$sh = New-Object -ComObject WScript.Shell
$lnk = $sh.CreateShortcut($linkPath)
$lnk.TargetPath = $Target
$lnk.WorkingDirectory = Split-Path -Parent $Target
$lnk.IconLocation = ($IconDest + ',0')
$lnk.Description = 'Xilian desktop pet'
$lnk.Save()

# verify by reading back (never trust "Save() returned")
$read = $sh.CreateShortcut($linkPath)
Write-Output ("link  : " + $linkPath)
Write-Output ("  target: " + $read.TargetPath)
Write-Output ("  icon  : " + $read.IconLocation)
if ($read.TargetPath -ne $Target) { throw 'readback mismatch: TargetPath' }
if ($read.IconLocation -ne ($IconDest + ',0')) { throw 'readback mismatch: IconLocation' }

# --- 4) nudge the shell so the new icon shows up without re-login ---------
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class XlShellNotify {
  [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
  public static extern void SHChangeNotify(int eventId, uint flags, IntPtr item1, IntPtr item2);
}
'@
$item = [System.Runtime.InteropServices.Marshal]::StringToHGlobalUni($linkPath)
try {
  [XlShellNotify]::SHChangeNotify(0x00002000, 0x0005, $item, [IntPtr]::Zero)   # SHCNE_UPDATEITEM | SHCNF_PATHW
  [XlShellNotify]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)  # SHCNE_ASSOCCHANGED
} finally {
  [System.Runtime.InteropServices.Marshal]::FreeHGlobal($item)
}

Write-Output 'shortcut: ready'
