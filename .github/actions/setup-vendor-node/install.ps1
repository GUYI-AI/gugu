$ErrorActionPreference = 'Stop'
$version = $env:VENDOR_NODE_VERSION
if (-not $version) {
  $versionFile = $env:VENDOR_NODE_VERSION_FILE
  if (-not [IO.Path]::IsPathRooted($versionFile)) { $versionFile = Join-Path $env:GITHUB_WORKSPACE $versionFile }
  $version = (Get-Content -LiteralPath $versionFile -Raw).Trim()
}
if ($version -cnotmatch '\A\d+\.\d+\.\d+\z') { throw 'An exact pinned Node version is required.' }
$arch = switch ($env:RUNNER_ARCH) { 'X64' { 'x64' } 'ARM64' { 'arm64' } default { throw 'Unsupported Windows Node build host.' } }
$name = "node-v$version-win-$arch"
$archive = "$name.zip"
$expected = $null
foreach ($line in (Get-Content -LiteralPath (Join-Path $env:GITHUB_ACTION_PATH 'node-checksums.txt'))) {
  if ($line -cmatch '\A([a-f0-9]{64})\s+(.+)\z' -and $Matches[2] -ceq $archive) { $expected = $Matches[1] }
}
if (-not $expected) { throw "Missing reviewed Node checksum for $archive" }
$cacheRoot = Join-Path $env:RUNNER_TOOL_CACHE 'gugu-vendor-node'
$cache = Join-Path $cacheRoot $expected
$executable = Join-Path $cache "$name/node.exe"
$marker = Join-Path $cache '.verified-sha256'
if ($env:VENDOR_NODE_CACHE_INFO -eq '1') {
  Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "cache-path=$cache"
  Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "cache-key=vendor-node-v1-win-$arch-$expected"
  exit 0
}
function Test-VerifiedCache {
  if (-not (Test-Path -LiteralPath $executable) -or -not (Test-Path -LiteralPath $marker)) { return $false }
  if ((Get-Content -LiteralPath $marker -Raw).Trim() -cne $expected) { return $false }
  $actual = & $executable --version
  return $LASTEXITCODE -eq 0 -and $actual -ceq "v$version"
}
if (-not (Test-VerifiedCache)) {
  New-Item -ItemType Directory -Path $cacheRoot -Force | Out-Null
  $stage = Join-Path $cacheRoot ('.vendor-node-' + [Guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Path $stage | Out-Null
  try {
    $download = Join-Path $stage $archive
    try {
      Invoke-WebRequest -Uri "https://download.gugu.nextmind.space/releases/vendor/node-toolchain/v$version/$archive" -OutFile $download -MaximumRedirection 0 -TimeoutSec 600
    } catch {
      Write-Output '::notice::Node mirror download failed; trying the official archive with the same pinned SHA256'
      Invoke-WebRequest -Uri "https://nodejs.org/dist/v$version/$archive" -OutFile $download -MaximumRedirection 0 -TimeoutSec 600
    }
    if ((Get-FileHash -LiteralPath $download -Algorithm SHA256).Hash.ToLowerInvariant() -cne $expected) { throw 'Node archive SHA256 mismatch; not extracted.' }
    Expand-Archive -LiteralPath $download -DestinationPath $stage
    $candidate = Join-Path $stage "$name/node.exe"
    $actual = & $candidate --version
    if ($LASTEXITCODE -ne 0 -or $actual -cne "v$version") { throw 'Node archive version differs from pin.' }
    Remove-Item -LiteralPath $download
    Set-Content -LiteralPath (Join-Path $stage '.verified-sha256') -Value $expected -NoNewline
    try { [IO.Directory]::Move($stage, $cache) }
    catch { if (-not [IO.Directory]::Exists($cache)) { throw } }
    if (-not (Test-VerifiedCache)) { throw 'Occupied or published Node cache is invalid.' }
  } finally {
    if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  }
}
Add-Content -LiteralPath $env:GITHUB_PATH -Value (Join-Path $cache $name)
Add-Content -LiteralPath $env:GITHUB_OUTPUT -Value "node-version=$version"
