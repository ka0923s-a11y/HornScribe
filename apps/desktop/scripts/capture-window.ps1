<#
.SYNOPSIS
  Capture the HornScribe window to a PNG (UI-001 render evidence).
  Tries PrintWindow(PW_RENDERFULLCONTENT) first; falls back to a screen
  region blit (works when the window is in the foreground).
#>
param(
  [Parameter(Mandatory = $true)][string]$ExePath,
  [Parameter(Mandatory = $true)][string]$OutPng,
  [int]$WaitSeconds = 10
)
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class Win32 {
  [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hWnd, IntPtr hdcBlt, uint nFlags);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT r);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
"@

$exe = Resolve-Path $ExePath
$proc = Start-Process -FilePath $exe -PassThru
$deadline = (Get-Date).AddSeconds(30)
while ((Get-Date) -lt $deadline) {
  $proc.Refresh()
  if ($proc.MainWindowTitle) { break }
  Start-Sleep -Milliseconds 50
}
if (-not $proc.MainWindowTitle) { throw "no window" }

Start-Sleep -Seconds $WaitSeconds
$proc.Refresh()
$hwnd = $proc.MainWindowHandle
[Win32]::SetForegroundWindow($hwnd) | Out-Null
Start-Sleep -Milliseconds 500
$r = New-Object Win32+RECT
[Win32]::GetWindowRect($hwnd, [ref]$r) | Out-Null
$w = $r.Right - $r.Left; $h = $r.Bottom - $r.Top

$bmp = New-Object System.Drawing.Bitmap $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$hdc = $g.GetHdc()
$ok = [Win32]::PrintWindow($hwnd, $hdc, 2)  # PW_RENDERFULLCONTENT
$g.ReleaseHdc($hdc); $g.Dispose()
if (-not $ok) {
  # fallback: screen blit
  $bmp = New-Object System.Drawing.Bitmap $w, $h
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($r.Left, $r.Top, 0, 0, $bmp.Size)
  $g.Dispose()
}
$bmp.Save($OutPng, [System.Drawing.Imaging.ImageFormat]::Png)
$bmp.Dispose()
Write-Output "saved $OutPng ($w x $h), printwindow=$ok"
Stop-Process -Id $proc.Id -Force -ErrorAction SilentlyContinue
