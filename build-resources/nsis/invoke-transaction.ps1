# Loaded as text by a constant -Command expression. Execution policy can forbid
# script files even with -ExecutionPolicy Bypass; paths/values are data in the
# Unicode request file, never interpolated into PowerShell source.
$ErrorActionPreference = 'Stop'
$diagnostic = Join-Path ([IO.Path]::GetTempPath()) 'gugu-installer\transaction-errors.jsonl'
$arguments = @{}
try {
  $allowed = @('Phase','Target','AppId','Executable','Version','InstallKey','UninstallKey','Mode','LinkManifest','FailureLog')
  foreach ($line in [IO.File]::ReadAllLines($env:GUGU_INSTALLER_REQUEST, [Text.Encoding]::Unicode)) {
    if ($line -match '^([^=]+)=(.*)$' -and $allowed -contains $Matches[1]) {
      $arguments[$Matches[1]] = $Matches[2]
    }
  }
  $arguments.DiagnosticLog = $diagnostic
  $global:LASTEXITCODE = 2
  & ([ScriptBlock]::Create([IO.File]::ReadAllText($env:GUGU_INSTALLER_HELPER))) @arguments
  exit $LASTEXITCODE
} catch {
  [Console]::Error.WriteLine($_.Exception.Message)
  $entry = [ordered]@{ time=[DateTime]::UtcNow.ToString('o'); phase=$arguments.Phase; version=$arguments.Version; target=$arguments.Target; error=$_.Exception.Message; cause=$_.Exception.GetBaseException().Message }
  try {
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($diagnostic)) | Out-Null
    [IO.File]::AppendAllText($diagnostic, ($entry | ConvertTo-Json -Compress) + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
  } catch { [Console]::Error.WriteLine('Could not write the installer diagnostic log') }
  exit 2
}
