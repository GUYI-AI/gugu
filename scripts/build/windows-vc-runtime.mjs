import { execFileSync } from 'node:child_process'
import { copyFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const peMachines = { x64: 0x8664, arm64: 0xaa64 }

export function assertPeMachine(file, arch) {
  const bytes = readFileSync(file)
  const header = bytes.length >= 0x40 ? bytes.readUInt32LE(0x3c) : 0
  const isPe = header >= 0x40 && bytes.length >= header + 6 && bytes.toString('latin1', header, header + 4) === 'PE\0\0'
  const machine = isPe ? bytes.readUInt16LE(header + 4) : undefined
  if (machine === undefined || machine !== peMachines[arch]) {
    throw new Error(`Expected a Windows ${arch} binary: ${file} (PE Machine: ${machine === undefined ? 'missing' : '0x' + machine.toString(16)})`)
  }
}

export function copyWindowsVcRuntime(destination, arch) {
  if (process.platform !== 'win32') throw new Error('Bundling the Windows VC runtime requires a Windows build host')
  if (!Object.hasOwn(peMachines, arch)) throw new Error(`Unsupported Windows VC runtime architecture: ${arch}`)
  // Use the redistributable supplied by the same VS 2022 toolchain as the native build.
  // Microsoft allows licensed users to distribute these files unmodified with their program.
  // https://learn.microsoft.com/visualstudio/releases/2022/redistribution#visual-c-runtime-files
  const powershell = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  const runtime = execFileSync(powershell, ['-NoProfile', '-NonInteractive', '-Command', String.raw`
    $ErrorActionPreference = 'Stop'
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    $vswhere = Join-Path ([Environment]::GetFolderPath('ProgramFilesX86')) 'Microsoft Visual Studio\Installer\vswhere.exe'
    $vs = & $vswhere -latest -products '*' -version '[17.0,18.0)' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
    if (-not $vs) { throw 'Visual Studio 2022 C++ build tools are required to bundle the app-local VC runtime' }
    $version = (Get-Content -LiteralPath (Join-Path $vs 'VC\Auxiliary\Build\Microsoft.VCRedistVersion.default.txt') -Raw).Trim()
    $runtime = Join-Path $vs "VC\Redist\MSVC\$version\${arch}\Microsoft.VC143.CRT\vcruntime140.dll"
    $signature = Get-AuthenticodeSignature -LiteralPath $runtime
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch '(?:^|,\s*)O=Microsoft Corporation(?:,|$)') {
      throw "Expected a valid Microsoft Authenticode signature for $runtime ($($signature.Status))"
    }
    $runtime
  `], { encoding: 'utf8' }).trim()
  assertPeMachine(runtime, arch)
  copyFileSync(runtime, join(destination, 'vcruntime140.dll'))
}
