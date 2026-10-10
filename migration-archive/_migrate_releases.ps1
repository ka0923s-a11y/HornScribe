$ErrorActionPreference = 'Continue'
Set-Location C:\Users\ka092\Desktop\HornScribe
$notes = '_migrate_notes.md'
$addon = 'dist\HornScribe-demucs-addon-4.1.0-win64.zip'
$versions = @('0.2.14','0.2.13','0.2.12','0.2.11','0.2.10','0.2.9','0.2.8','0.2.7','0.2.6','0.2.5','0.2.4','0.2.3','0.2.2','0.2.1','0.2.0','0.1.0')
$log = '_migrate_releases.log'
foreach ($v in $versions) {
  $tag = "v$v"
  $zip = "dist\HornScribe-$v-portable-win-x64.zip"
  if (-not (Test-Path $zip)) { "$(Get-Date -Format o) SKIP $tag no zip" | Add-Content $log; continue }
  $assets = @($zip)
  if ([version]$v -ge [version]'0.2.11' -and (Test-Path $addon)) { $assets += $addon }
  "$(Get-Date -Format o) CREATE $tag assets=$($assets -join ',')" | Add-Content $log
  $out = gh release create $tag @assets --repo aaw123m/horn --prerelease --title "HornScribe $tag" --notes-file $notes 2>&1 | Out-String
  if ($LASTEXITCODE -ne 0) {
    "$(Get-Date -Format o) CREATE-FAILED $tag : $out" | Add-Content $log
    foreach ($a in $assets) {
      $u = gh release upload $tag $a --repo aaw123m/horn --clobber 2>&1 | Out-String
      "$(Get-Date -Format o) UPLOAD $tag $a -> $u" | Add-Content $log
    }
  } else {
    "$(Get-Date -Format o) OK $tag" | Add-Content $log
  }
}
"$(Get-Date -Format o) DONE" | Add-Content $log

