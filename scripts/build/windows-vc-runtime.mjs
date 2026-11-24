import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const peMachines = { x64: 0x8664, arm64: 0xaa64 }

function readWindowsBinary(file, arch) {
  const bytes = readFileSync(file)
  const header = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : 0
  const isPe = header >= 0x40 && bytes.length >= header + 6 && bytes.toString('latin1', header, header + 4) === 'PE\0\0'
  const machine = isPe ? bytes.readUInt16LE(header + 4) : undefined
  if (machine === undefined || machine !== peMachines[arch]) {
    throw new Error(`Expected a Windows ${arch} binary: ${file} (PE Machine: ${machine === undefined ? 'missing' : '0x' + machine.toString(16)})`)
  }
  return bytes
}

export function assertPeMachine(file, arch) {
  readWindowsBinary(file, arch)
}

export function copyWindowsVcRuntime(destination, arch, expected) {
  if (process.platform !== 'win32') throw new Error('Bundling the Windows VC runtime requires a Windows build host')
  if (!Object.hasOwn(peMachines, arch)) throw new Error(`Unsupported Windows VC runtime architecture: ${arch}`)
  // Use the redistributable supplied by the same VS 2022 toolchain as the native build.
  // Microsoft allows licensed users to distribute these files unmodified with their program.
  // https://learn.microsoft.com/visualstudio/releases/2022/redistribution#visual-c-runtime-files
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const verification = expected ? String.raw`
    $signature = Get-AuthenticodeSignature -LiteralPath $runtime
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
      throw "Expected a valid Microsoft Authenticode signature for $runtime ($($signature.Status))"
    }
    $fileVersion = (Get-Item -LiteralPath $runtime).VersionInfo
    $info.version = '{0}.{1}.{2}.{3}' -f $fileVersion.FileMajorPart, $fileVersion.FileMinorPart, $fileVersion.FileBuildPart, $fileVersion.FilePrivatePart
  ` : ''
  const info = JSON.parse(execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    # CI can inherit a PS7 module path. Use the modules for this Windows PowerShell.
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
    $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = & $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { throw 'Visual Studio 2022 C++ build tools are required to bundle the app-local VC runtime' }
    $version = (Get-Content -LiteralPath (Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCRedistVersion.default.txt') -Raw).Trim()
    $runtime = Join-Path $vs ('VC\Redist\MSVC\{0}\{1}\Microsoft.VC143.CRT\vcruntime140.dll' -f $version, '${arch}')
    $info = @{ path = $runtime }
    ${verification}
    $info | ConvertTo-Json -Compress
  `], { encoding: 'utf8' }).trim())
  const bytes = readWindowsBinary(info.path, arch)
  if (expected) {
    const sha256 = createHash('sha256').update(bytes).digest('hex')
    if (info.version !== expected.version || sha256 !== expected.sha256) {
      throw new Error(`Unexpected app-local VC runtime at ${info.path}: version ${info.version}, SHA-256 ${sha256}. Expected version ${expected.version}, SHA-256 ${expected.sha256}.`)
    }
  }
  writeFileSync(join(destination, 'vcruntime140.dll'), bytes)
}
