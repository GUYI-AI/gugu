// Local protocol conversion for custom models (cc-switch-cli, MIT). The build takes the release pinned in
// scripts/cc-switch-release.json, checks its sha256, and places it in cc-switch-bundle/<os>-<arch>/. The desktop package
// carries it through electron-builder's extraResources; the server package copies it in build-gugu-server.mjs.
// Archives go through the same content-addressed cache as mise and frpc. A target with no pinned binary (Windows arm64)
// gets no bundle, and the router reports the missing component when a converted model is used.
import { execFileSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defaultMiseCacheDir, obtainMiseArchive } from './mise-archive-cache.mts'
import { assertPeMachine, copyWindowsVcRuntime } from './windows-vc-runtime.mjs'

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const release = JSON.parse(readFileSync(join(root, 'scripts', 'cc-switch-release.json'), 'utf8'))
const value = (flag, fallback) => (process.argv.includes(flag) ? process.argv[process.argv.indexOf(flag) + 1] : fallback)
const platform = value('--platform', process.platform)
const arch = value('--arch', process.arch)
const osName = { darwin: 'mac', win32: 'win', linux: 'linux' }[platform]
const target = release.assets[`${platform}-${arch}`]
if (!target) {
  console.log(`[build-cc-switch] no pinned cc-switch for ${platform}-${arch}; converted custom models stay unavailable there`)
  process.exit(0)
}
const exe = platform === 'win32' ? 'cc-switch.exe' : 'cc-switch'
const destination = join(root, 'cc-switch-bundle', `${osName}-${arch}`)
const stamp = JSON.stringify({ version: release.version, sha256: target.sha256 })

if (existsSync(join(destination, exe)) && existsSync(join(destination, 'release.json')) && readFileSync(join(destination, 'release.json'), 'utf8') === stamp) {
  console.log(`[build-cc-switch] pinned cc-switch already present: ${platform}-${arch}`)
} else {
  const archive = obtainMiseArchive({
    cacheDir: defaultMiseCacheDir(),
    downloadBase: 'https://github.com/SaladDay/cc-switch-cli/releases/download',
    version: release.version,
    asset: target.asset,
    sha256: target.sha256,
  })
  mkdirSync(join(root, 'cc-switch-bundle'), { recursive: true })
  const temporary = mkdtempSync(join(root, 'cc-switch-bundle', '.staging-'))
  try {
    if (target.asset.endsWith('.zip')) {
      if (process.platform === 'win32') {
        execFileSync(join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', archive, '-C', temporary], { stdio: 'inherit' })
      } else {
        execFileSync('unzip', ['-q', archive, '-d', temporary], { stdio: 'inherit' })
      }
    } else {
      execFileSync('tar', ['-xzf', archive, '-C', temporary], { stdio: 'inherit' })
    }
    const binary = join(temporary, exe)
    if (!existsSync(binary)) throw new Error(`${target.asset} does not contain ${exe}`)
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(destination, { recursive: true })
    copyFileSync(binary, join(destination, exe))
    copyFileSync(join(root, 'scripts', 'cc-switch-LICENSE'), join(destination, 'LICENSE'))
    chmodSync(join(destination, exe), 0o755)
    writeFileSync(join(destination, 'release.json'), stamp)
    console.log(`[build-cc-switch] bundled cc-switch v${release.version} for ${platform}-${arch}`)
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
}

if (platform === 'win32') {
  // The x64 converter needs the matching CRT even when it runs under Windows on Arm emulation.
  // Do this for cached bundles too, including ones prepared before the app-local DLL was added.
  assertPeMachine(join(destination, exe), arch)
  const runtime = {
    version: '14.44.35211.0',
    sha256: 'd5e4d9a3e835fa679450145d6a7d94e36573a509317111904d9b3712c30d9066',
  }
  copyWindowsVcRuntime(destination, arch, runtime)
  console.log(`[build-cc-switch] bundled Microsoft vcruntime140.dll ${runtime.version} for ${arch}`)
}
