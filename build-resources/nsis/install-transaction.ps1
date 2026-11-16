param(
  [Parameter(Mandatory=$true)][ValidateSet('prepare','commit','finish','rollback')][string]$Phase,
  [Parameter(Mandatory=$true)][string]$Target,
  [Parameter(Mandatory=$true)][string]$AppId,
  [Parameter(Mandatory=$true)][string]$Executable,
  [Parameter(Mandatory=$true)][string]$Version,
  [Parameter(Mandatory=$true)][string]$InstallKey,
  [Parameter(Mandatory=$true)][string]$UninstallKey,
  [Parameter(Mandatory=$true)][ValidateSet('all','CurrentUser')][string]$Mode,
  [string]$LinkManifest,
  # @@@install-failure-log — NSIS shows this script's error only in its "Show details" pane, which is gone once the
  # window closes (a field report had nothing but "Installation Aborted" at ~3/4 progress). Every failure is also
  # appended here; the app reads it on its next start and records it in its own log.
  [string]$FailureLog = (Join-Path ([Environment]::GetFolderPath('CommonApplicationData')) ("gugu\installer\" + [IO.Path]::GetFileNameWithoutExtension($Executable) + '.log'))
)
# Runs from NSIS's private plugin directory, never from a directory being renamed.
# No network, Node installation, profile, user-data deletion, or process termination.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
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

function Retry-Files([scriptblock]$operation) {
  $delays = @(50,100,200,400,800)
  for ($attempt=0; ; $attempt++) {
    try { & $operation; return } catch {
      $cause = $_.Exception.GetBaseException()
      if ($attempt -ge $delays.Count -or
          ($cause -isnot [IO.IOException] -and $cause -isnot [UnauthorizedAccessException])) { throw }
      Start-Sleep -Milliseconds $delays[$attempt]
    }
  }
}
# @@@commit-holders — the two directory renames of commit are the one step any open handle under the tree refuses,
# and every kind of holder fails it the same way ("being used by another process": a file open even with delete
# sharing, or a process whose working directory is inside). Holders seen in the field are transient (antivirus or the
# search indexer reading freshly extracted files, processes still exiting), so the renames get a longer, bounded
# retry window than other file operations. If they still fail, the holders at that moment are recorded for the log.
$script:moveFailure = $null
function Move-Tree([string]$from, [string]$to) {
  $delays = @(100,200,400,800,1000,1500,2000,2000,3000,3000,4000,4000,4000,4000)  # ~30 s in total
  for ($attempt=0; ; $attempt++) {
    try { [IO.Directory]::Move($from, $to); return } catch {
      $cause = $_.Exception.GetBaseException()
      if ($cause -isnot [IO.IOException] -and $cause -isnot [UnauthorizedAccessException]) { throw }
      if ($attempt -ge $delays.Count) {
        $script:moveFailure = [ordered]@{ step="$from -> $to"; attempts=$attempt+1; holders=@(Get-TreeHolders $from) }
        throw
      }
      Start-Sleep -Milliseconds $delays[$attempt]
    }
  }
}
function Get-TreeHolders([string]$dir) {
  try {
    if (-not ('GuguTreeHolders' -as [type])) {
      Add-Type -TypeDefinition @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class GuguTreeHolders {
  [StructLayout(LayoutKind.Sequential)] struct RM_UNIQUE_PROCESS { public int dwProcessId; public System.Runtime.InteropServices.ComTypes.FILETIME ProcessStartTime; }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct RM_PROCESS_INFO { public RM_UNIQUE_PROCESS Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string strAppName; [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string strServiceShortName;
    public int ApplicationType; public uint AppStatus; public uint TSSessionId; [MarshalAs(UnmanagedType.Bool)] public bool bRestartable; }
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint h, int f, StringBuilder key);
  [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint h);
  [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint h, uint n, string[] files, uint a, IntPtr b, uint c, string[] d);
  [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint h, out uint needed, ref uint n, [In, Out] RM_PROCESS_INFO[] info, ref uint reasons);
  // Processes holding any of the files open (Restart Manager), in batches.
  public static List<string> FileHolders(string[] files) {
    var found = new Dictionary<int,string>();
    for (int i = 0; i < files.Length; i += 1000) {
      var batch = new string[Math.Min(1000, files.Length - i)]; Array.Copy(files, i, batch, 0, batch.Length);
      uint h; if (RmStartSession(out h, 0, new StringBuilder(64)) != 0) continue;
      try {
        if (RmRegisterResources(h, (uint)batch.Length, batch, 0, IntPtr.Zero, 0, null) != 0) continue;
        uint needed = 0, n = 0, reasons = 0; RmGetList(h, out needed, ref n, null, ref reasons);
        if (needed == 0) continue;
        var info = new RM_PROCESS_INFO[needed]; n = needed;
        if (RmGetList(h, out needed, ref n, info, ref reasons) != 0) continue;
        for (int j = 0; j < n; j++) found[info[j].Process.dwProcessId] = info[j].strAppName + (string.IsNullOrEmpty(info[j].strServiceShortName) ? "" : " (service " + info[j].strServiceShortName + ")");
      } finally { RmEndSession(h); }
    }
    var list = new List<string>(); foreach (var kv in found) list.Add(kv.Key + " " + kv.Value); return list;
  }
  [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int c, ref PBI p, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr h, IntPtr a, byte[] b, int s, out IntPtr r);
  [StructLayout(LayoutKind.Sequential)] struct PBI { public IntPtr R1; public IntPtr Peb; public IntPtr R2a; public IntPtr R2b; public IntPtr Pid; public IntPtr R3; }
  // A process's working directory (read from its PEB; 64-bit processes). Restart Manager does not report directory handles.
  public static string WorkingDirectory(int pid) {
    IntPtr h = OpenProcess(0x0410, false, pid); if (h == IntPtr.Zero) return null;
    try {
      var p = new PBI(); int rl; if (NtQueryInformationProcess(h, 0, ref p, Marshal.SizeOf(p), out rl) != 0 || p.Peb == IntPtr.Zero) return null;
      var b = new byte[8]; IntPtr r; if (!ReadProcessMemory(h, p.Peb + 0x20, b, 8, out r)) return null;
      var pp = (IntPtr)BitConverter.ToInt64(b, 0); var us = new byte[16];
      if (pp == IntPtr.Zero || !ReadProcessMemory(h, pp + 0x38, us, 16, out r)) return null;
      int len = BitConverter.ToUInt16(us, 0); var s = new byte[len];
      if (!ReadProcessMemory(h, (IntPtr)BitConverter.ToInt64(us, 8), s, len, out r)) return null;
      return Encoding.Unicode.GetString(s);
    } finally { CloseHandle(h); }
  }
}
"@
    }
    $prefix = $dir.TrimEnd('\') + '\'
    $processes = @{}; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $processes[[int]$_.ProcessId] = $_ }
    $describe = { param($id, $why) $p = $processes[[int]$id]; "$id $(if ($p) { $p.Name } else { '?' }) [$why] $(if ($p) { $p.CommandLine })" }
    $files = @(Get-ChildItem -LiteralPath $dir -Recurse -File -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.FullName })
    $out = @([GuguTreeHolders]::FileHolders([string[]]$files) | ForEach-Object { $id, $name = $_ -split ' ', 2; & $describe $id "open file: $name" })
    foreach ($id in $processes.Keys) {
      $cwd = [GuguTreeHolders]::WorkingDirectory($id)
      if ($cwd -and ($cwd.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase) -or $cwd.TrimEnd('\') -eq $dir.TrimEnd('\'))) { $out += & $describe $id "working directory $cwd" }
    }
    return $out
  } catch { return @("holder scan failed: $($_.Exception.Message)") }
}
function Save-State($s) {
  $temp = "$statePath.tmp"
  [IO.File]::WriteAllText($temp, ($s | ConvertTo-Json -Depth 8), (New-Object Text.UTF8Encoding($false)))
  # Windows PowerShell converts $null to an empty string for string arguments;
  # Replace requires a real null (no backup), not an invalid empty backup path.
  if ([IO.File]::Exists($statePath)) { Retry-Files { [IO.File]::Replace($temp, $statePath, [NullString]::Value) } }
  else { Retry-Files { [IO.File]::Move($temp, $statePath) } }
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
  if (Test-Path -LiteralPath $stage) { Retry-Files { Remove-Item -LiteralPath $stage -Recurse -Force } }
}
function Snapshot-Shortcuts {
  $files = @(); $missing = @()
  if (-not $LinkManifest) { return @{ files=@(); missing=@() } }
  foreach ($line in Get-Content -LiteralPath $LinkManifest -Encoding Unicode) {
    if ($line -notmatch '^[^=]+=(.+)$') { continue }
    $path = [IO.Path]::GetFullPath($Matches[1])
    if ([IO.Path]::GetExtension($path) -ne '.lnk') { throw 'Invalid shortcut snapshot path' }
    if (@($files | Where-Object { $_.path -eq $path }).Count) { continue }
    $file = "shortcut-$($files.Count).lnk"
    $exists = [IO.File]::Exists($path)
    if ($exists) { Copy-Item -LiteralPath $path -Destination (Join-Path $journal $file) }
    $files += @{ path=$path; file=$file; existed=$exists }
    $parent = [IO.Path]::GetDirectoryName($path)
    while ($parent -and -not [IO.Directory]::Exists($parent)) {
      $missing += $parent; $parent = [IO.Path]::GetDirectoryName($parent)
    }
  }
  return @{ files=@($files); missing=@($missing | Select-Object -Unique) }
}
function Restore-Shortcuts($s) {
  if (-not $s.shortcuts) { return }
  foreach ($link in $s.shortcuts.files) {
    if ($link.file -notmatch '^shortcut-\d+\.lnk$' -or [IO.Path]::GetExtension($link.path) -ne '.lnk') { throw 'Invalid shortcut journal; preserved' }
    if ($link.existed) {
      [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($link.path)) | Out-Null
      Copy-Item -LiteralPath (Join-Path $journal $link.file) -Destination $link.path -Force
    } elseif ([IO.File]::Exists($link.path)) { Remove-Item -LiteralPath $link.path -Force }
  }
  foreach ($parent in @($s.shortcuts.missing | Sort-Object Length -Descending)) {
    if ([IO.Directory]::Exists($parent) -and @(Get-ChildItem -LiteralPath $parent -Force).Count -eq 0) { [IO.Directory]::Delete($parent) }
  }
}
function Restore-State($s) {
  # A marker proves that the new target belongs to this transaction. Never remove an
  # unrelated replacement directory, including one created after a crash.
  $marker = Join-Path $Target '.gugu-install-transaction'
  if (Test-Path -LiteralPath $marker) {
    if (([IO.File]::ReadAllText($marker)) -ne $s.token) { throw 'Target ownership changed; rollback preserved' }
    Retry-Files { Remove-Item -LiteralPath $Target -Recurse -Force }
  }
  foreach ($entry in @($s.roots)) {
    if (Test-Path -LiteralPath $entry.backup) {
      if (Test-Path -LiteralPath $entry.root) { throw 'Old install location is occupied; backup preserved' }
      Retry-Files { [IO.Directory]::Move($entry.backup, $entry.root) }
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
  Restore-Shortcuts $s
  Remove-OwnedStage
  Remove-Item -LiteralPath $journal -Recurse -Force
}
function Finish-State($s) {
  # Persist completion before deletion. A crash during backup cleanup must never
  # roll a successfully registered new version back to a partly deleted old tree.
  $s.completed = $true
  Save-State $s
  foreach ($entry in $s.roots) {
    if (Test-Path -LiteralPath $entry.backup) { Retry-Files { Remove-Item -LiteralPath $entry.backup -Recurse -Force } }
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
    $s.shortcuts = Snapshot-Shortcuts
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
    foreach ($entry in $s.roots) { Move-Tree $entry.root $entry.backup }
    Move-Tree $stage $Target
    $s.registryMayHaveChanged = $true
    Save-State $s
  } else {
    $s = Load-State
    if ($s.completed) { Finish-State $s; exit 0 }
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
  $failure = $_.Exception
  if ($Phase -eq 'finish' -and (Test-Path -LiteralPath $statePath)) {
    # Consult the persisted commit, not the in-memory flag: a full disk may have
    # prevented Save-State itself, in which case backups are still for rollback.
    try {
      $persisted = Load-State
      if ($persisted.completed) {
        [Console]::Error.WriteLine('The new application is installed. Backup cleanup will be retried on the next installation.')
        exit 0
      }
    } catch { [Console]::Error.WriteLine('Could not confirm the persisted installation commit') }
  }
  # Preserve the original failure. A rollback failure leaves the journal/backups
  # intact, and a later invocation retries instead of deleting uncertain data.
  if ($Phase -ne 'rollback' -and (Test-Path -LiteralPath $statePath)) {
    try { $s = Load-State; if (-not $s.completed) { Restore-State $s } } catch { [Console]::Error.WriteLine("Rollback preserved: $($_.Exception.Message)") }
  }
  try {
    $roots = @($Target) + @(if ($s) { $s.roots | ForEach-Object { $_.root } })
    $entry = [ordered]@{ time=[DateTime]::UtcNow.ToString('o'); phase=$Phase; version=$Version; mode=$Mode; target=$Target; error=$failure.Message; cause=$failure.GetBaseException().Message
      # Which rename was refused and who held that tree when the retries ran out (see @@@commit-holders).
      step=$(if ($script:moveFailure) { $script:moveFailure.step }); holders=$(if ($script:moveFailure) { $script:moveFailure.holders } else { @() })
      # What still runs from the trees being replaced: the usual reason a directory rename is refused.
      running=@(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $path = $_.ExecutablePath; $path -and @($roots | Where-Object { $path.StartsWith("$_\", [StringComparison]::OrdinalIgnoreCase) }).Count } | ForEach-Object { "$($_.ProcessId) $($_.ExecutablePath)" }) }
    New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($FailureLog)) -Force | Out-Null
    $kept = @(if (Test-Path -LiteralPath $FailureLog) { Get-Content -LiteralPath $FailureLog -Encoding UTF8 | Select-Object -Last 49 })
    [IO.File]::WriteAllLines($FailureLog, [string[]]($kept + ($entry | ConvertTo-Json -Compress)), (New-Object Text.UTF8Encoding($false)))
  } catch { [Console]::Error.WriteLine("Could not record the failure in ${FailureLog}: $($_.Exception.Message)") }
  exit 2
}
