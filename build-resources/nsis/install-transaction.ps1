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
  [string]$DiagnosticLog,
  # @@@install-failure-log — keep the application-readable failure log in addition
  # to the NSIS diagnostic directory shown before an installation aborts.
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

function Test-OwnedResidue([string]$directory) {
  # A filename alone is not ownership. Old installers did not leave a durable
  # marker, so recognize their executable's embedded Gugu product identity.
  # If a manifest survived too, it must agree rather than contradict that identity.
  $exe = Join-Path $directory $Executable
  foreach ($path in @($directory,$exe)) {
    if (-not (Test-Path -LiteralPath $path) -or
        ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { return $false }
  }
  try {
    $identity = [Diagnostics.FileVersionInfo]::GetVersionInfo($exe)
    if ($identity.CompanyName -ne 'Gugu' -or $identity.ProductName -notmatch '^(Gugu|咕咕)([ -]?Beta)?$') { return $false }
    if (($Executable -match '-beta\.exe$') -ne ($identity.ProductName -match 'Beta$')) { return $false }
    $manifest = Join-Path $directory 'resources\app\package.json'
    if (Test-Path -LiteralPath $manifest) {
      foreach ($path in @((Join-Path $directory 'resources'),(Join-Path $directory 'resources\app'),$manifest)) {
        if ((Get-Item -LiteralPath $path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
      }
      $package = [IO.File]::ReadAllText($manifest) | ConvertFrom-Json
      if ($package.name -notin @('gugu','gugu-beta') -or $package.productName -ne $identity.ProductName -or
          $package.version -notmatch '^\d+\.\d+\.\d+([+-].+)?$' -or
          $package.main -notin @('apps/desktop/dist-electron/main.js','dist-electron/main.js')) { return $false }
    }
    return $true
  } catch { return $false }
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
  $delays = @(100,200,400,800,1000,1500,2000,2000,2000)  # 10 s; retain time for extraction and an actionable failure under 60 s
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
  # Every open handle whose object lies under the tree, from the system handle table: files, directories and working
  # directories alike, 32- and 64-bit processes alike. (Restart Manager reports no directory handles, and a 32-bit
  # process's working directory is not in its 64-bit process parameters - that is exactly how the waiting UAC
  # installer's handle was first missed.) Handles are duplicated into this process only to read their names.
  try {
    if (-not ('GuguTreeHolders' -as [type])) {
      # @@@add-type-cwd - the installer runs this script from its plugin directory, which holds NSIS's own 32-bit
      # System.dll; Add-Type's compiler resolves the System reference from the working directory first and fails on it.
      $cwd = [Environment]::CurrentDirectory; [Environment]::CurrentDirectory = $env:SystemRoot
      try { Add-Type -TypeDefinition @"
using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text; using System.Threading;
public static class GuguTreeHolders {
  [StructLayout(LayoutKind.Sequential)] struct Entry { public IntPtr Object; public IntPtr Pid; public IntPtr Handle; public uint Access; public ushort Backtrace; public ushort Type; public uint Attributes; public uint Reserved; }
  [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int c, IntPtr b, int l, out int r);
  [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr h, int c, IntPtr b, int l, out int r);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int a, bool i, int pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr sp, IntPtr sh, IntPtr tp, out IntPtr th, uint a, bool i, uint o);
  [DllImport("kernel32.dll")] static extern uint GetFileType(IntPtr h);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] static extern uint QueryDosDevice(string d, StringBuilder t, int m);
  // Object names can block on some file objects; each read gets a short budget on its own thread.
  static string Name(IntPtr h) {
    string res = null;
    var t = new Thread(() => { IntPtr b = Marshal.AllocHGlobal(4096); try { int r; if (NtQueryObject(h, 1, b, 4096, out r) == 0) { int len = Marshal.ReadInt16(b); IntPtr p = Marshal.ReadIntPtr(b, IntPtr.Size); if (len > 0 && p != IntPtr.Zero) res = Marshal.PtrToStringUni(p, len / 2); } } finally { Marshal.FreeHGlobal(b); } });
    t.IsBackground = true; t.Start(); return t.Join(200) ? res : null;
  }
  public static List<string> Under(string dir) {
    var dev = new StringBuilder(512); QueryDosDevice(dir.Substring(0, 2), dev, 512);
    string root = dev.ToString() + dir.Substring(2).TrimEnd('\\');
    var found = new List<string>(); int len = 1 << 24, r; IntPtr buf;
    while (true) { buf = Marshal.AllocHGlobal(len); int st = NtQuerySystemInformation(64, buf, len, out r); if (st == 0) break; Marshal.FreeHGlobal(buf); if (st != unchecked((int)0xC0000004)) throw new Exception("NtQuerySystemInformation 0x" + st.ToString("X")); len = Math.Max(len * 2, r + 65536); }
    try {
      long count = Marshal.ReadInt64(buf); int size = Marshal.SizeOf(typeof(Entry)); var procs = new Dictionary<long, IntPtr>(); IntPtr me = GetCurrentProcess(); int fileType = -1;
      for (long i = 0; i < count; i++) {
        var e = (Entry)Marshal.PtrToStructure(buf + 16 + (int)(i * size), typeof(Entry)); long pid = e.Pid.ToInt64();
        if (pid <= 4 || (fileType != -1 && e.Type != fileType)) continue;
        IntPtr ph; if (!procs.TryGetValue(pid, out ph)) { ph = OpenProcess(0x40, false, (int)pid); procs[pid] = ph; }
        IntPtr d; if (ph == IntPtr.Zero || !DuplicateHandle(ph, e.Handle, me, out d, 0, false, 2)) continue;
        try {
          if (GetFileType(d) != 1) continue; // pipes cannot hold the install tree and their names may block
          if (fileType == -1) fileType = e.Type;
          string n = Name(d);
          if (n != null && (n.Equals(root, StringComparison.OrdinalIgnoreCase) || n.StartsWith(root + "\\", StringComparison.OrdinalIgnoreCase)))
            found.Add(pid + "\t0x" + e.Access.ToString("X") + "\t" + n.Substring(dev.Length));
        } finally { CloseHandle(d); }
      }
      foreach (var p in procs.Values) if (p != IntPtr.Zero) CloseHandle(p);
    } finally { Marshal.FreeHGlobal(buf); }
    return found;
  }
}
"@ } finally { [Environment]::CurrentDirectory = $cwd }
    }
    $processes = @{}; Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | ForEach-Object { $processes[[int]$_.ProcessId] = $_ }
    return @([GuguTreeHolders]::Under($dir) | ForEach-Object {
      $id, $access, $path = $_ -split "`t", 3; $p = $processes[[int]$id]
      "$id $(if ($p) { $p.Name } else { '?' }) [handle $access on $($dir.Substring(0, 2))$path] $(if ($p) { $p.CommandLine })"
    })
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
      if (Test-Path -LiteralPath $entry.root) {
        # NSIS can recreate its destination before prepare. A verified journal
        # may recover through that empty directory, never through foreign files.
        if ($entry.root -eq $s.target -and [IO.Directory]::Exists($entry.root) -and
            @(Get-ChildItem -LiteralPath $entry.root -Force).Count -eq 0) {
          [IO.Directory]::Delete($entry.root)
        } else { throw 'Old install location is occupied; backup preserved' }
      }
      Retry-Files { [IO.Directory]::Move($entry.backup, $entry.root) }
    }
  }
  if ($s.registryMayHaveChanged) {
    foreach ($snapshot in $s.registry) {
      if ($snapshot.existed) {
        if (Test-Path -LiteralPath (Registry-Path $snapshot.key.Split('\',2)[0] $snapshot.key.Split('\',2)[1])) {
          & $reg delete $snapshot.key /f | Out-Null
          if ($LASTEXITCODE -ne 0) { throw 'Could not reset installation registration' }
        }
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
      if (@(Get-ChildItem -LiteralPath $Target -Force).Count) {
        if (-not (Test-OwnedResidue $Target)) {
          $script:unrecognizedTarget = $true
          throw "Unregistered target contains unrecognized files; choose a new empty installation folder. Preserved: $Target"
        }
        $backup = "$Target.gugu-backup-$AppId"
        if (Test-Path -LiteralPath $backup) { throw 'Unclaimed backup exists; preserved' }
        # Treat a recognized residue exactly like a registered old tree. It is
        # backed up at commit and restored with absent registration on failure.
        $roots += @{ root=$Target; backup=$backup }
      } else { Remove-Item -LiteralPath $Target }
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
    foreach ($destination in @($DiagnosticLog,$FailureLog) | Where-Object { $_ } | Select-Object -Unique) {
      try {
        New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($destination)) -Force | Out-Null
        $kept = @(if (Test-Path -LiteralPath $destination) { Get-Content -LiteralPath $destination -Encoding UTF8 | Select-Object -Last 49 })
        [IO.File]::WriteAllLines($destination, [string[]]($kept + ($entry | ConvertTo-Json -Compress)), (New-Object Text.UTF8Encoding($false)))
      } catch { [Console]::Error.WriteLine("Could not record the failure in ${destination}: $($_.Exception.Message)") }
    }
  } catch { [Console]::Error.WriteLine("Could not record the failure in ${FailureLog}: $($_.Exception.Message)") }
  if ($script:moveFailure -and @($script:moveFailure.holders | Where-Object { $_ -match '^\d+ ' }).Count) { exit 3 }
  if ($script:unrecognizedTarget) { exit 4 }
  exit 2
}
