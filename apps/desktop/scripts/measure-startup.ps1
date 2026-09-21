<#
.SYNOPSIS
  UI-001 cold-start + baseline memory measurement for the HornScribe shell.

.DESCRIPTION
  Launches the built app, polls until the main window exists (window title
  assigned => Win32 window created), then until the WebView2 child processes
  appear, and snapshots working-set / private memory of the whole process
  tree (app + msedgewebview2 children tagged with this app's user-data dir).

  Cold-start definition used here: process creation -> window present.
  WebView2 content-ready is approximated by the first render process for
  our user-data folder plus a short settle delay; it is recorded separately.

.EXAMPLE
  pwsh scripts/measure-startup.ps1 -ExePath ..\src-tauri\target\release\hornscribe-desktop.exe -SettleSeconds 5
#>
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [int]$SettleSeconds = 5,
  [int]$TimeoutSeconds = 30,
  [switch]$KeepRunning
)

$ErrorActionPreference = "Stop"
$exe = Resolve-Path $ExePath
$name = [IO.Path]::GetFileNameWithoutExtension($exe)

$t0 = Get-Date
$proc = Start-Process -FilePath $exe -PassThru
if (-not $proc) { throw "failed to start $exe" }

# --- Phase 1: window present -------------------------------------------------
$windowAt = $null
while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSeconds) {
  $proc.Refresh()
  if ($proc.HasExited) { throw "process exited before showing a window (code $($proc.ExitCode))" }
  if ($proc.MainWindowTitle) { $windowAt = Get-Date; break }
  Start-Sleep -Milliseconds 25
}
if (-not $windowAt) { throw "no main window within $TimeoutSeconds s" }

# --- Phase 2: WebView2 children for this app ---------------------------------
# WebView2 spawns msedgewebview2.exe children whose command line carries the
# app's user-data folder (…\EBWebView under the app data dir or next to the exe).
$wvChildrenAt = $null
$wv = @()
while (((Get-Date) - $t0).TotalSeconds -lt $TimeoutSeconds) {
  $wv = Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" |
        Where-Object { $_.CommandLine -like "*$name*" }
  if ($wv) { $wvChildrenAt = Get-Date; break }
  Start-Sleep -Milliseconds 50
}

Start-Sleep -Seconds $SettleSeconds

# --- Memory snapshot ----------------------------------------------------------
$proc.Refresh()
$appWs  = if ($proc.HasExited) { 0 } else { $proc.WorkingSet64 }
$appPvt = if ($proc.HasExited) { 0 } else { $proc.PrivateMemorySize64 }
$wvWs = 0; $wvPvt = 0; $wvCount = 0
foreach ($w in $wv) {
  try {
    $p = Get-Process -Id $w.ProcessId -ErrorAction Stop
    $wvWs += $p.WorkingSet64; $wvPvt += $p.PrivateMemorySize64; $wvCount++
  } catch {}
}
$totalWs  = $appWs + $wvWs
$totalPvt = $appPvt + $wvPvt

[pscustomobject]@{
  Exe                       = $exe.Path
  Pid                       = $proc.Id
  ColdStartToWindowMs       = [int](($windowAt - $t0).TotalMilliseconds)
  WebView2ChildrenAtMs      = if ($wvChildrenAt) { [int](($wvChildrenAt - $t0).TotalMilliseconds) } else { $null }
  AppWorkingSetMB           = [math]::Round($appWs / 1MB, 1)
  AppPrivateMB              = [math]::Round($appPvt / 1MB, 1)
  WebView2ChildCount        = $wvCount
  WebView2WorkingSetMB      = [math]::Round($wvWs / 1MB, 1)
  TotalWorkingSetMB         = [math]::Round($totalWs / 1MB, 1)
  TotalPrivateMB            = [math]::Round($totalPvt / 1MB, 1)
  SettleSeconds             = $SettleSeconds
  Timestamp                 = (Get-Date).ToString("o")
}

if (-not $KeepRunning -and -not $proc.HasExited) {
  Stop-Process -Id $proc.Id -Force
}
