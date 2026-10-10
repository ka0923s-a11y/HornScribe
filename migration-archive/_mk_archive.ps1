Set-Location C:\Users\ka092\Desktop\HornScribe
if (Test-Path migration-archive\work) { Remove-Item migration-archive\work -Recurse -Force }
$base = (Get-Item .work).FullName
$files = Get-ChildItem .work -Recurse -File | Where-Object { $_.Extension -in '.md','.txt','.json','.csv' -and $_.Length -lt 20MB }
foreach ($f in $files) {
  $rel = $f.FullName.Substring($base.Length+1)
  $dst = Join-Path 'migration-archive\work' $rel
  New-Item -ItemType Directory -Force (Split-Path $dst) | Out-Null
  Copy-Item $f.FullName $dst
}
(Get-ChildItem migration-archive -Recurse -File | Measure-Object).Count

