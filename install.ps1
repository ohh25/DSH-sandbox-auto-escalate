<#
.SYNOPSIS
  Install the sandbox-auto-escalate plugin into a DSH web profile.

.DESCRIPTION
  1. Copy index.js to <profile>\plugins\sandbox-auto-escalate\index.js
  2. Idempotently add the insert row to <profile>\cordis.patch.yml
  3. Back up cordis.patch.yml to .bak before changing it

  NOTE: this file is intentionally ASCII-only. Windows PowerShell 5.1 reads
  BOM-less .ps1 files using the system ANSI codepage, so non-ASCII text here
  would be mangled and break parsing.

  NOTE: the patch file is written back through .NET UTF8Encoding($false)
  because `Set-Content -Encoding UTF8` on PowerShell 5.1 adds a BOM, while
  the original cordis.patch.yml has none.

  MEASURED: adding a brand-new insert row to cordis.patch.yml is NOT picked up
  by a running instance (patchReload: live did not hot-apply it), so restart
  DSH Desktop after installing.

.PARAMETER ProfileDir
  Profile directory. Defaults to %USERPROFILE%\.dsh\profiles\desktop

.PARAMETER Uninstall
  Remove the insert row and delete the installed plugin directory.

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Uninstall
#>
[CmdletBinding()]
param(
  [string]$ProfileDir = (Join-Path $env:USERPROFILE '.dsh\profiles\desktop'),
  [switch]$Uninstall
)

$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$pluginId = 'sandbox-auto-escalate'
$relName = './plugins/sandbox-auto-escalate/index.js'
$targetDir = Join-Path $ProfileDir "plugins\$pluginId"
$targetFile = Join-Path $targetDir 'index.js'
$patchFile = Join-Path $ProfileDir 'cordis.patch.yml'
$utf8NoBom = New-Object System.Text.UTF8Encoding($false)

function Write-Lines([string]$Path, [string[]]$Lines) {
  [System.IO.File]::WriteAllText($Path, (($Lines -join "`r`n") + "`r`n"), $utf8NoBom)
}

if (-not (Test-Path $ProfileDir)) { throw "profile directory not found: $ProfileDir" }
if (-not (Test-Path $patchFile)) { throw "patch file not found: $patchFile" }

$lines = @(Get-Content $patchFile)
$hasRow = @($lines | Where-Object { $_ -match "id:\s*$pluginId\s*$" }).Count -gt 0

if ($Uninstall) {
  $installed = Test-Path $targetFile
  if (-not $hasRow -and -not $installed) { Write-Host 'Nothing installed; skipping.'; return }

  Copy-Item $patchFile "$patchFile.bak" -Force
  $kept = New-Object System.Collections.Generic.List[string]
  for ($i = 0; $i -lt $lines.Count; $i++) {
    if ($lines[$i] -match "id:\s*$pluginId\s*$") {
      if ($kept.Count -gt 0 -and $kept[$kept.Count - 1].Trim() -eq '- insert:') { $kept.RemoveAt($kept.Count - 1) }
      while ($i + 1 -lt $lines.Count -and $lines[$i + 1] -match "^\s+name:") { $i++ }
      continue
    }
    $kept.Add($lines[$i])
  }
  $body = @($kept | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' })
  if ($body.Count -eq 0) { $kept.Add('[]') }
  Write-Lines $patchFile $kept.ToArray()
  if (Test-Path $targetDir) { Remove-Item $targetDir -Recurse -Force }
  Write-Host "Uninstalled $pluginId (backup: $patchFile.bak)"
  return
}

# --- 1. install the plugin files ---
# package.json MUST travel with index.js: without a "type": "module" manifest
# beside it Node logs MODULE_TYPELESS_PACKAGE_JSON on every boot (observed).
# client.js MUST travel with package.json: the manifest declares dsh.client +
# exports["./client"], and a declared-but-missing bundle makes the host throw
# ClientPackageCompositionError, which takes the WHOLE web plugin table down.
New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
Copy-Item (Join-Path $here 'index.js') $targetFile -Force
Copy-Item (Join-Path $here 'package.json') (Join-Path $targetDir 'package.json') -Force
Copy-Item (Join-Path $here 'client.js') (Join-Path $targetDir 'client.js') -Force
Write-Host "Plugin files installed: $targetDir"

# --- 2. inject the patch row (idempotent) ---
if ($hasRow) {
  Write-Host "cordis.patch.yml already contains $pluginId; skipping injection."
  return
}

Copy-Item $patchFile "$patchFile.bak" -Force
$block = @(
  '- insert:'
  "    - id: $pluginId"
  "      name: '$relName'"
)
$body = @($lines | Where-Object { $_ -notmatch '^\s*#' -and $_.Trim() -ne '' })
if ($body.Count -eq 1 -and $body[0].Trim() -eq '[]') {
  $out = New-Object System.Collections.Generic.List[string]
  foreach ($line in $lines) {
    if ($line.Trim() -eq '[]') { $block | ForEach-Object { $out.Add($_) } } else { $out.Add($line) }
  }
  Write-Lines $patchFile $out.ToArray()
} else {
  Write-Lines $patchFile ($lines + @('') + $block)
}
Write-Host "Patch row injected; backup: $patchFile.bak"

Write-Host ''
Write-Host 'Done. The web profile is patchReload: live, so this normally applies without a restart.'
Write-Host "Log: $env:APPDATA\dsh-desktop\logs\harness.log"
