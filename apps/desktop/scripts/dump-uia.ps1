<#
.SYNOPSIS
  Dump the UIA element names of the HornScribe window (UI-001 a11y evidence).
  Verifies accessible names resolve to Japanese strings.
#>
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [int]$WaitSeconds = 8
)
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes

$exe = Resolve-Path $ExePath
$proc = Start-Process -FilePath $exe -PassThru
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $proc.Refresh()
  if ($proc.MainWindowHandle -ne [IntPtr]::Zero -and $proc.MainWindowTitle) { break }
  Start-Sleep -Milliseconds 50
}
Start-Sleep -Seconds $WaitSeconds
$proc.Refresh()

$auto = [System.Windows.Automation.AutomationElement]::FromHandle($proc.MainWindowHandle)
Write-Output "WINDOW: $($auto.Current.Name)"

$walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$seen = 0
function Walk($el, $depth) {
  if ($depth -gt 8 -or $script:seen -gt 120) { return }
  $c = $walker.GetFirstChild($el)
  while ($c) {
    $script:seen++
    $name = $c.Current.Name
    $type = $c.Current.ControlType.ProgrammaticName -replace "ControlType\.",""
    if ($name) { Write-Output ("  " * $depth + "[$type] $name") }
    Walk $c ($depth + 1)
    $c = $walker.GetNextSibling($c)
  }
}
Walk $auto 0
Write-Output "TOTAL named/control elements walked: $seen"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
