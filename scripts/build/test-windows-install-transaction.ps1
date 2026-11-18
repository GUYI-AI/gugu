param([string]$Helper = (Join-Path $PSScriptRoot '..\..\build-resources\nsis\install-transaction.ps1'), [string]$Entry = (Join-Path $PSScriptRoot '..\..\build-resources\nsis\invoke-transaction.ps1'))
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
$priorTemp = $env:TEMP; $priorTmp = $env:TMP
$priorEntry = $env:GUGU_INSTALLER_ENTRY; $priorHelper = $env:GUGU_INSTALLER_HELPER; $priorRequest = $env:GUGU_INSTALLER_REQUEST
$links = Join-Path $root 'links.ini'
$failLog = Join-Path $root 'installer\fixture.log'
# The installer runs the helper from its plugin directory, next to NSIS's 32-bit System.dll; run it from such a directory.
$plugins = Join-Path $root 'plugins'
$oldLink = Join-Path $root 'old.lnk'
$newLink = Join-Path $root 'new-menu\new.lnk'
function Assert($condition, $message) { if (-not $condition) { throw $message } }
function Invoke-Phase($phase, [int]$expected = 0) {
  $prior=$ErrorActionPreference
  try {
    $ErrorActionPreference='Continue' # Expected fault cases intentionally write native stderr.
    Push-Location $plugins
    $request = Join-Path $root 'request.ini'
    [IO.File]::WriteAllText($request, "[transaction]`r`nPhase=$phase`r`nTarget=$target`r`nAppId=$app`r`nExecutable=fixture.exe`r`nVersion=0.3.5`r`nInstallKey=$key`r`nUninstallKey=$uninstall`r`nMode=CurrentUser`r`nLinkManifest=$links`r`nFailureLog=$failLog`r`n", [Text.Encoding]::Unicode)
    $env:GUGU_INSTALLER_ENTRY = $Entry
    $env:GUGU_INSTALLER_HELPER = $Helper
    $env:GUGU_INSTALLER_REQUEST = $request
    & $powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command '& ([ScriptBlock]::Create([IO.File]::ReadAllText($env:GUGU_INSTALLER_ENTRY)))'
    $code=$LASTEXITCODE
  } finally { Pop-Location; $ErrorActionPreference=$prior }
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
  $env:TEMP = Join-Path $root 'temp'; $env:TMP = $env:TEMP
  New-Item -ItemType Directory -Path $env:TEMP | Out-Null
  New-Item -ItemType Directory -Path $plugins | Out-Null
  [IO.File]::WriteAllBytes((Join-Path $plugins 'System.dll'), [byte[]](@(0x4D, 0x5A) + @(0) * 126)) # not a .NET assembly
  [IO.File]::WriteAllText($links, "[links]`r`nold=$oldLink`r`nnew=$newLink`r`n", [Text.Encoding]::Unicode)
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

  [IO.File]::WriteAllText($oldLink, 'original shortcut bytes')
  Invoke-Phase prepare
  Payload $stage 'not-registered'
  Invoke-Phase commit
  [IO.File]::WriteAllText($oldLink, 'new target')
  New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($newLink)) | Out-Null
  [IO.File]::WriteAllText($newLink, 'new shortcut')
  Invoke-Phase finish 2
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'upgrade') 'Registration failure lost old application'
  Assert ((Get-ItemProperty -LiteralPath "HKCU:\$uninstall").DisplayVersion -eq '0.3.4') 'Registration rollback failed'
  $results += 'failed registration restores old tree and registry'
  Assert (([IO.File]::ReadAllText($oldLink)) -eq 'original shortcut bytes') 'Original shortcut was not restored'
  Assert (-not(Test-Path $newLink)) 'Failed install left a new shortcut'
  Assert (-not(Test-Path ([IO.Path]::GetDirectoryName($newLink)))) 'Failed install left a new shortcut directory'
  $results += 'failed registration restores shortcut bytes and removes new links/directories'

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
  try { Invoke-Phase commit 3 } finally { $locked.Dispose() }
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'upgrade') 'Locked old application was changed'
  $results += 'locked old executable fails without losing installation'
  $failures = @(Get-Content -LiteralPath $failLog -Encoding UTF8 | ForEach-Object { $_ | ConvertFrom-Json })
  Assert ($failures.Count -eq 2) "Expected 2 recorded failures, found $($failures.Count)"
  Assert ($failures[0].phase -eq 'finish' -and $failures[0].error -match 'registration') 'Registration failure was not recorded'
  Assert ($failures[1].phase -eq 'commit' -and $failures[1].version -eq '0.3.5' -and $failures[1].cause) 'Locked-tree failure was not recorded with its cause'
  $results += 'every failure is recorded for the next app start; successes record nothing'
  Assert ($failures[1].step -like "$target -> *") 'Locked-tree failure did not name the refused rename'
  Assert (@($failures[1].holders | Where-Object { $_ -match "^$PID .*\[handle .*fixture\.exe\]" }).Count -eq 1) "Locked-tree failure did not name this process as the holder: $($failures[1].holders -join ' | ')"
  $results += 'a refused rename names its step and the process holding the tree'

  # A process whose working directory is inside the old tree is a holder too, and is named as one.
  Invoke-Phase prepare
  Payload $stage 'cwd-held'
  $holder = Start-Process -FilePath $powershell -ArgumentList '-NoProfile','-Command','Start-Sleep 120' -WorkingDirectory (Join-Path $target 'resources') -WindowStyle Hidden -PassThru
  try { Invoke-Phase commit 3 } finally { Stop-Process -Id $holder.Id -Force; $holder.WaitForExit() }
  $last = Get-Content -LiteralPath $failLog -Encoding UTF8 | Select-Object -Last 1 | ConvertFrom-Json
  Assert (@($last.holders | Where-Object { $_ -match "^$($holder.Id) .*\[handle .*\\resources\]" }).Count -eq 1) "Working-directory holder was not named: $($last.holders -join ' | ')"
  $results += 'a process working inside the old tree is named as the holder'

  # A holder that lets go within the retry window (antivirus, indexer, an exiting process) no longer aborts the install.
  Invoke-Phase prepare
  Payload $stage 'transient'
  $brief = Start-Process -FilePath $powershell -ArgumentList '-NoProfile','-Command',"`$f=[IO.File]::Open('$(Join-Path $target 'fixture.exe')','Open','Read','Read'); Start-Sleep 4; `$f.Dispose()" -WindowStyle Hidden -PassThru
  Start-Sleep -Milliseconds 1500
  Invoke-Phase commit
  $brief.WaitForExit()
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'transient') 'Transient holder still aborted the commit'
  Registration '0.3.5'
  Invoke-Phase finish
  $results += 'a transient holder is waited out instead of aborting'

  # NSIS may recreate a missing destination before prepare recovers a journal.
  Invoke-Phase prepare
  Payload $stage 'not-published'
  [IO.Directory]::Move($target, $backup)
  New-Item -ItemType Directory -Path $target | Out-Null
  Invoke-Phase prepare
  Assert (([IO.File]::ReadAllText((Join-Path $target 'fixture.exe'))) -eq 'transient') 'Empty recreated target blocked recovery'
  Invoke-Phase rollback
  $results += 'a missing destination recovers through the empty directory NSIS recreated'

  # A failed import may leave a previously existing key absent. Retrying rollback
  # must import it, rather than treating delete-of-a-missing-key as a new failure.
  Invoke-Phase prepare
  Payload $stage 'registration-retry'
  Invoke-Phase commit
  $state = Get-Content -LiteralPath (Join-Path $journal 'transaction.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $snapshot = Join-Path $journal $state.registry[0].file
  $original = [IO.File]::ReadAllBytes($snapshot)
  [IO.File]::WriteAllText($snapshot, 'not a registry file')
  Invoke-Phase rollback 2
  Assert (-not (Test-Path -LiteralPath "HKCU:\$key")) 'Failed import did not reach the missing-key recovery case'
  [IO.File]::WriteAllBytes($snapshot, $original)
  Invoke-Phase rollback
  Assert ((Get-ItemProperty -LiteralPath "HKCU:\$uninstall").DisplayVersion -eq '0.3.5') 'Registration import was not retryable'
  Assert (-not (Test-Path -LiteralPath $journal)) 'Retried rollback left its journal'
  $results += 'registration rollback retries after delete succeeds and import fails'

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
  $env:TEMP = $priorTemp; $env:TMP = $priorTmp
  $env:GUGU_INSTALLER_ENTRY = $priorEntry; $env:GUGU_INSTALLER_HELPER = $priorHelper; $env:GUGU_INSTALLER_REQUEST = $priorRequest
  Remove-Item -LiteralPath "HKCU:\Software\GuguInstallerFixture\$id" -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
