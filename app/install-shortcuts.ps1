# Creates "Tando" shortcuts on the Desktop and in the Start menu.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File app\install-shortcuts.ps1
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$exe = Join-Path $app 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "Electron isn't installed yet. Run: cd `"$app`"; npm install" }

$shell = New-Object -ComObject WScript.Shell
# Remove shortcuts left from the app's old name.
foreach ($old in @('Desktop', 'Programs')) { Remove-Item (Join-Path ([Environment]::GetFolderPath($old)) 'meta IDE.lnk') -ErrorAction SilentlyContinue }
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Tando.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'Tando.lnk')
)
foreach ($lnk in $targets) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.Arguments = "`"$app`""          # no folder: reopens your last project
  $s.WorkingDirectory = $app
  $s.Description = 'Tando: coding-agent sessions side by side, with files and Markdown in one window'
  $ico = Join-Path $app 'renderer\icon.ico'
  $s.IconLocation = $(if (Test-Path $ico) { "$ico,0" } else { "$exe,0" })
  $s.Save()
  Write-Output "created $lnk"
}
