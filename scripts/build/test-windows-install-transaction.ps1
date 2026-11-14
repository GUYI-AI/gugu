param([string]$Helper = (Join-Path $PSScriptRoot '..\..\build-resources\nsis\install-transaction.ps1'))
# Run explicitly on Windows. Every registry key and directory belongs to this
# fixture; it does not install an application or touch a real user's registration.
$ErrorActionPreference = 'Stop'
$id = [Guid]::NewGuid().ToString('N')
$root = Join-Path ([IO.Path]::GetTempPath()) "gugu-install-fixture-$id"
$target = Join-Path $root '应用 with spaces'
$app = "gugu.fixture.$id"
$key = "Software\GuguInstallerFixture\$id\install"
$uninstall = "Software\GuguInstallerFixture\$id\uninstall"
$journal = "$target.gugu-install-$app"
$stage = Join-Path $journal 'stage'
$backup = "$target.gugu-backup-$app"
$powershell = (Get-Process -Id $PID).Path
$results = @()
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Invoke-Phase($phase, [int]$expected = 0) {
  $prior=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue' # Expected fault cases intentionally write native stderr.
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $Helper -Phase $phase -Target $target -AppId $app -Executable 'fixture.exe' -Version '0.3.5' -InstallKey $key -UninstallKey $uninstall -Mode CurrentUser
    $code=$LASTEXITCODE
  } finally { $ErrorActionPreference=$prior }
  Assert ($code -eq $expected) "$phase returned $code, expected $expected"
}
function Payload($dir, $text) {
  New-Item -ItemType Directory -Path (Join-Path $dir 'resources\app') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $dir 'fixture.exe'), $text)
  [IO.File]::WriteAllText((Join-Path $dir 'resources\app\package.json'), '{}')
}
function Registration($version) {
  New-Item -Path "HKCU:\$key" -Force | Out-Null
  New-Item -Path "HKCU:\$uninstall" -Force | Out-Null
  Set-ItemProperty -LiteralPath "HKCU:\$key" -Name InstallLocation -Value $target
  Set-ItemProperty -LiteralPath "HKCU:\$uninstall" -Name DisplayVersion -Value $version
}
try {
  New-Item -ItemType Directory -Path $root | Out-Null
  $data = Join-Path $root 'user-data-must-survive'
  [IO.File]::WriteAllText($data, 'preserved')
  Invoke-Phase prepare
  Payload $stage 'clean'
  Invoke-Phase commit
  Registration '0.3.5'
  Invoke-Phase finish
  Assert (-not (Test-Path -LiteralPath $journal)) 'Clean journal was not removed'
  $results += 'clean installation and Unicode path'

  [IO.File]::WriteAllText((Join-Path $target 'obsolete.js'), 'old')
  Registration '0.3.4'
  Invoke-Phase prepare
  Payload $stage 'upgrade'
  Invoke-Phase commit
  Assert (Test-Path -LiteralPath $backup) 'Old tree was not retained before registration'
  Assert (-not (Test-Path -LiteralPath (Join-Path $target 'obsolete.js'))) 'Old file leaked into new payload'
  Registration '0.3.5'
  Invoke-Phase finish
  Assert (-not (Test-Path -LiteralPath $backup)) 'Successful backup cleanup failed'
  $results += 'same-channel upgrade replaces the complete tree'

  Registration '0.3.4'
  Invoke-Phase prepare
  Payload $stage 'incomplete-extraction'
  Invoke-Phase rollback
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'upgrade') 'Extraction failure changed old application'
  $results += 'extraction failure cleanup'

  Invoke-Phase prepare
  Payload $stage 'not-registered'
  Invoke-Phase commit
  Invoke-Phase finish 2
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'upgrade') 'Registration failure lost old application'
  Assert ((Get-ItemProperty -LiteralPath "HKCU:\$uninstall").DisplayVersion -eq '0.3.4') 'Registration rollback failed'
  $results += 'failed registration restores old tree and registry'

  Invoke-Phase prepare
  Payload $stage 'interrupted'
  [IO.Directory]::Move($target, $backup)
  Invoke-Phase prepare
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'upgrade') 'Crash recovery lost old application'
  Invoke-Phase rollback
  $results += 'crash between renames recovers on retry'

  Invoke-Phase prepare
  Payload $stage 'locked'
  $locked = [IO.File]::Open((Join-Path $target 'fixture.exe'), [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try { Invoke-Phase commit 2 } finally { $locked.Dispose() }
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'upgrade') 'Locked old application was changed'
  $results += 'locked old executable fails without losing installation'

  Invoke-Phase prepare
  Payload $stage 'committed'
  Invoke-Phase commit
  Registration '0.3.5'
  $persisted = Get-Content -LiteralPath (Join-Path $journal 'transaction.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $persisted.completed = $true
  [IO.File]::WriteAllText((Join-Path $journal 'transaction.json'), ($persisted | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  Remove-Item -LiteralPath (Join-Path $target '.gugu-install-transaction')
  Invoke-Phase finish
  Assert (-not (Test-Path -LiteralPath $journal)) 'Committed cleanup retry left its journal'
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'committed') 'Committed cleanup retry rolled back the new application'
  $results += 'committed cleanup resumes after marker deletion'
  Assert (([IO.File]::ReadAllText($data)) -eq 'preserved') 'User data changed'
  $results += 'user data remains intact'
  $results | ConvertTo-Json
} finally {
  Remove-Item -LiteralPath "HKCU:\Software\GuguInstallerFixture\$id" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
