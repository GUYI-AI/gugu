param(
  [Parameter(Mandatory=$true)][ValidateSet('prepare','commit','finish','rollback')][string]$Phase,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$AppId,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$InstallKey,
  [Parameter(Mandatory=$true)][string]$UninstallKey,
  [Parameter(Mandatory=$true)][ValidateSet('all','CurrentUser')][string]$Mode
)
# Runs from NSIS's private plugin directory, never from a directory being renamed.
# No network, Node installation, profile, user-data deletion, or process termination.
$ErrorActionPreference = 'Stop'
$Target = [IO.Path]::GetFullPath($Target).TrimEnd('\')
if ($Target -eq [IO.Path]::GetPathRoot($Target).TrimEnd('\')) { throw 'Cannot install at a volume root' }
$journal = "$Target.gugu-install-$AppId"
$statePath = Join-Path $journal 'transaction.json'
$stage = Join-Path $journal 'stage'
$reg = Join-Path $env:SystemRoot 'System32\reg.exe'
function Registry-Path([string]$hive, [string]$key) {
  $full = if ($hive -eq 'HKLM') { 'HKEY_LOCAL_MACHINE' } else { 'HKEY_CURRENT_USER' }
  return "Registry::$full\$key"
}

function Save-State($s) {
  $temp = "$statePath.tmp"
  [IO.File]::WriteAllText($temp, ($s | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  if ([IO.File]::Exists($statePath)) { [IO.File]::Replace($temp, $statePath, $null) }
  else { [IO.File]::Move($temp, $statePath) }
}
function Load-State {
  $s = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
  if ($s.appId -ne $AppId -or $s.target -ne $Target -or $s.format -ne 1) { throw 'Unknown installer journal; preserved for inspection' }
  foreach ($entry in $s.roots) {
    if ($entry.backup -ne "$($entry.root).gugu-backup-$AppId") { throw 'Invalid backup path; preserved for inspection' }
  }
  return $s
}
function Remove-OwnedStage {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
function Restore-State($s) {
  # A marker proves that the new target belongs to this transaction. Never remove an
  # unrelated replacement directory, including one created after a crash.
  $marker = Join-Path $Target '.gugu-install-transaction'
  if (Test-Path -LiteralPath $marker) {
    if (([IO.File]::ReadAllText($marker)) -ne $s.token) { throw 'Target ownership changed; rollback preserved' }
    Remove-Item -LiteralPath $Target -Recurse -Force
  }
  foreach ($entry in @($s.roots)) {
    if (Test-Path -LiteralPath $entry.backup) {
      if (Test-Path -LiteralPath $entry.root) { throw 'Old install location is occupied; backup preserved' }
      [IO.Directory]::Move($entry.backup, $entry.root)
    }
  }
  if ($s.registryMayHaveChanged) {
    foreach ($snapshot in $s.registry) {
      if ($snapshot.existed) {
        & $reg delete $snapshot.key /f | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not reset installation registration' }
        & $reg import (Join-Path $journal $snapshot.file) | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'Could not restore installation registration' }
      } else {
        if (Test-Path -LiteralPath (Registry-Path $snapshot.key.Split('\',2)[0] $snapshot.key.Split('\',2)[1])) {
          & $reg delete $snapshot.key /f | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'Could not remove incomplete registration' }
        }
      }
    }
  }
  Remove-OwnedStage
  Remove-Item -LiteralPath $journal -Recurse -Force
}
function Finish-State($s) {
  # Persist completion before deletion. A crash during backup cleanup must never
  # roll a successfully registered new version back to a partly deleted old tree.
  $s.completed = $true
  Save-State $s
  foreach ($entry in $s.roots) {
    if (Test-Path -LiteralPath $entry.backup) { Remove-Item -LiteralPath $entry.backup -Recurse -Force }
  }
  $marker = Join-Path $Target '.gugu-install-transaction'
  if ((Test-Path -LiteralPath $marker) -and ([IO.File]::ReadAllText($marker)) -eq $s.token) { Remove-Item -LiteralPath $marker }
  Remove-Item -LiteralPath $journal -Recurse -Force
}

try {
  if ($Phase -eq 'prepare') {
    if (Test-Path -LiteralPath $journal) {
      $previous = Load-State
      if ($previous.completed) { Finish-State $previous } else { Restore-State $previous }
    }
    $scope = if ($Mode -eq 'all') { @('HKLM','HKCU') } else { @('HKCU') }
    $roots = @()
    $snapshots = @()
    # Explicit 64-bit PowerShell is selected by NSIS. Registry paths are passed as
    # arguments, never interpolated into PowerShell source or shell expressions.
    foreach ($hive in $scope) {
      $location = (Get-ItemProperty -LiteralPath (Registry-Path $hive $InstallKey) -ErrorAction SilentlyContinue).InstallLocation
      if (-not $location) {
        $uninstall = (Get-ItemProperty -LiteralPath (Registry-Path $hive $UninstallKey) -ErrorAction SilentlyContinue).UninstallString
        if ($uninstall -match '^"([^"]+)"') { $location = [IO.Path]::GetDirectoryName($Matches[1]) }
      }
      if ($location -and (Test-Path -LiteralPath $location)) {
        $location = [IO.Path]::GetFullPath($location).TrimEnd('\')
        if (-not (Test-Path -LiteralPath (Join-Path $location $Executable))) { throw 'Registered install has no expected executable; preserved' }
        if ($roots.root -notcontains $location) {
          $backup = "$location.gugu-backup-$AppId"
          if (Test-Path -LiteralPath $backup) { throw 'Unclaimed backup exists; preserved' }
          $roots += @{ root=$location; backup=$backup }
        }
      }
    }
    if ((Test-Path -LiteralPath $Target) -and ($roots.root -notcontains $Target)) {
      if (@(Get-ChildItem -LiteralPath $Target -Force).Count) { throw 'Unregistered target is not empty; preserved' }
      Remove-Item -LiteralPath $Target
    }
    foreach ($entry in $roots) {
      if ($Target.StartsWith("$($entry.root)\", [StringComparison]::OrdinalIgnoreCase) -or
          $entry.root.StartsWith("$Target\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Nested installation locations cannot be replaced safely' }
      foreach ($other in $roots) {
        if ($other.root.StartsWith("$($entry.root)\", [StringComparison]::OrdinalIgnoreCase)) { throw 'Nested registered installations cannot be replaced safely' }
      }
    }
    New-Item -ItemType Directory -Path $journal | Out-Null
    $s = @{ format=1; appId=$AppId; target=$Target; token=[Guid]::NewGuid().ToString('N'); roots=@($roots); registry=@(); registryMayHaveChanged=$false; completed=$false }
    Save-State $s
    foreach ($hive in $scope) {
      foreach ($key in @($InstallKey,$UninstallKey)) {
        $file = "registry-$($snapshots.Count).reg"
        $exists = Test-Path -LiteralPath (Registry-Path $hive $key)
        if ($exists) {
          & $reg export "$hive\$key" (Join-Path $journal $file) /y | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'Could not snapshot installation registration' }
        }
        $snapshots += @{ key="$hive\$key"; file=$file; existed=$exists }
      }
    }
    $s.registry = @($snapshots)
    Save-State $s
    New-Item -ItemType Directory -Path $stage | Out-Null
  } elseif ($Phase -eq 'rollback') {
    if (Test-Path -LiteralPath $statePath) { $s = Load-State; if (-not $s.completed) { Restore-State $s } }
  } elseif ($Phase -eq 'commit') {
    $s = Load-State
    if (-not (Test-Path -LiteralPath (Join-Path $stage $Executable)) -or
        -not (Test-Path -LiteralPath (Join-Path $stage 'resources\app\package.json'))) { throw 'Incomplete staged application' }
    [IO.File]::WriteAllText((Join-Path $stage '.gugu-install-transaction'), $s.token)
    # Persist intent before the first rename. Recovery inspects actual paths, so a
    # crash between any two renames cannot lose the untouched old installation.
    foreach ($entry in $s.roots) { [IO.Directory]::Move($entry.root, $entry.backup) }
    [IO.Directory]::Move($stage, $Target)
    $s.registryMayHaveChanged = $true
    Save-State $s
  } else {
    $s = Load-State
    if (-not (Test-Path -LiteralPath (Join-Path $Target $Executable))) { throw 'Published application is missing' }
    if ([IO.File]::ReadAllText((Join-Path $Target '.gugu-install-transaction')) -ne $s.token) { throw 'Published application ownership changed' }
    $hive = if ($Mode -eq 'all') { 'HKLM' } else { 'HKCU' }
    if ((Get-ItemProperty -LiteralPath (Registry-Path $hive $InstallKey)).InstallLocation -ne $Target -or
        (Get-ItemProperty -LiteralPath (Registry-Path $hive $UninstallKey)).DisplayVersion -ne $Version) { throw 'New application registration failed' }
    # On scope conversion the new registration supersedes the current-user entry.
    if ($Mode -eq 'all') {
      foreach ($key in @($InstallKey,$UninstallKey)) {
        if (Test-Path -LiteralPath (Registry-Path 'HKCU' $key)) {
          & $reg delete "HKCU\$key" /f | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'Could not supersede current-user registration' }
        }
      }
    }
    Finish-State $s
  }
  exit 0
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  if ($Phase -eq 'finish' -and $s.completed) {
    [Console]::Error.WriteLine('The new application is installed. Backup cleanup will be retried on the next installation.')
    exit 0
  }
  # Preserve the original failure. A rollback failure leaves the journal/backups
  # intact, and a later invocation retries instead of deleting uncertain data.
  if ($Phase -ne 'rollback' -and (Test-Path -LiteralPath $statePath)) {
    try { $s = Load-State; if (-not $s.completed) { Restore-State $s } } catch { [Console]::Error.WriteLine("Rollback preserved: $($_.Exception.Message)") }
  }
  exit 2
}
