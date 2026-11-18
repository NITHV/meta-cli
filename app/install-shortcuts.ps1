# Creates "meta IDE" shortcuts on the Desktop and in the Start menu.
# Run from anywhere:  powershell -ExecutionPolicy Bypass -File app\install-shortcuts.ps1
$ErrorActionPreference = 'Stop'
$app = $PSScriptRoot
$exe = Join-Path $app 'node_modules\electron\dist\electron.exe'
if (-not (Test-Path $exe)) { throw "Electron isn't installed yet. Run: cd `"$app`"; npm install --allow-scripts=electron" }

$shell = New-Object -ComObject WScript.Shell
$targets = @(
  (Join-Path ([Environment]::GetFolderPath('Desktop')) 'meta IDE.lnk'),
  (Join-Path ([Environment]::GetFolderPath('Programs')) 'meta IDE.lnk')
)
foreach ($lnk in $targets) {
  $s = $shell.CreateShortcut($lnk)
  $s.TargetPath = $exe
  $s.Arguments = "`"$app`""          # no folder: reopens your last project
  $s.WorkingDirectory = $app
  $s.Description = 'meta IDE: Claude Code sessions, files and Markdown in one window'
  $s.IconLocation = "$exe,0"
  $s.Save()
  Write-Output "created $lnk"
}
