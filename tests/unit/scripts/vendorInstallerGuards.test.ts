import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { configure, verifyArchive, pins } = require_('../../../scripts/build/sqlite-prebuild-guard.cjs')
const { configureVendorDownloads } = require_('../../../scripts/build/vendor-download-env.cjs')
const origin = 'https://download.gugu.nextmind.space/releases/vendor/'

describe('installer archive boundaries', () => {
  it('uses the reviewed SQLite archive without forwarding a GitHub credential', () => {
    const opts = { pkg: { name: 'better-sqlite3', version: '12.11.1' }, runtime: 'node', abi: '137', platform: 'linux', arch: 'x64', token: 'not-a-real-token', download: 'https://github.com/unreviewed' }
    configure(opts)
    expect(opts.download).toBe(origin + 'better-sqlite3/v12.11.1/better-sqlite3-v12.11.1-node-v137-linux-x64.tar.gz')
    expect(opts).not.toHaveProperty('token')
  })

  it('keeps another ABI on the original source-build path and leaves other packages alone', () => {
    const opts = { pkg: { name: 'better-sqlite3', version: '12.11.1' }, runtime: 'electron', abi: '149', platform: 'linux', arch: 'x64', buildFromSource: false, download: '' }
    configure(opts)
    expect(opts.buildFromSource).toBe(true)
    expect(opts.download).toMatch(/^https:\/\/download\.gugu\.nextmind\.space\//)
    const other = { pkg: { name: 'another-package' }, download: 'https://example.org/original' }
    configure(other)
    expect(other.download).toBe('https://example.org/original')
  })

  it('rejects corrupt local/cache bytes and a foreign origin before extraction or native loading', () => {
    const directory = mkdtempSync(join(tmpdir(), 'vendor-prebuild-'))
    try {
      const file = join(directory, 'archive.tar.gz')
      writeFileSync(file, 'corrupt archive')
      const opts = { pkg: { name: 'better-sqlite3' } }
      const name = Object.keys(pins)[0]
      expect(() => verifyArchive(file, opts, origin + 'better-sqlite3/v12.11.1/' + name)).toThrow('SHA256 mismatch')
      expect(() => verifyArchive(file, opts, 'https://github.com/example/' + name)).toThrow('Unreviewed')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps installer pins and the pnpm patch guard identical to the reviewed inventory', () => {
    const root = resolve(__dirname, '../../..')
    const inventory = JSON.parse(readFileSync(join(root, 'scripts/build/vendor-build-pins.json'), 'utf8'))
    expect(pins).toEqual(Object.fromEntries(inventory.artifacts.filter((item: { component: string }) => item.component === 'better-sqlite3').map((item: { file: string; sha256: string }) => [item.file, item.sha256])))
    const patch = readFileSync(join(root, 'patches/prebuild-install@7.1.3.patch'), 'utf8')
    const added = patch.split('diff --git a/gugu-vendor.js b/gugu-vendor.js\n')[1].split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n') + '\n'
    expect(added).toBe(readFileSync(join(root, 'scripts/build/sqlite-prebuild-guard.cjs'), 'utf8'))
  })

  it('pins every Node bootstrap archive and retains the official Mac toolchain hashes', () => {
    const root = resolve(__dirname, '../../..')
    const inventory = JSON.parse(readFileSync(join(root, 'scripts/build/vendor-build-pins.json'), 'utf8'))
    const checksums = readFileSync(join(root, '.github/actions/setup-vendor-node/node-checksums.txt'), 'utf8')
    const version = readFileSync(join(root, '.node-version'), 'utf8').trim()
    expect(inventory.nodeVersion).toBe(version)
    for (const item of inventory.artifacts.filter((item: { component: string }) => item.component === 'node-toolchain')) {
      expect(checksums).toContain(`${item.sha256}  ${item.file}\n`)
    }
    expect(checksums.trim().split('\n')).toHaveLength(10)
  })

  it('keeps Windows bootstrap independent of a Git Bash installation', () => {
    const root = resolve(__dirname, '../../..')
    const action = readFileSync(join(root, '.github/actions/setup-vendor-node/action.yml'), 'utf8')
    expect(action).toContain("if: runner.os == 'Windows'\n      shell: pwsh")
    expect(action).toContain("if: runner.os != 'Windows'\n      shell: bash")
    const windows = readFileSync(join(root, '.github/actions/setup-vendor-node/install.ps1'), 'utf8')
    expect(windows).toContain('Get-FileHash')
    expect(windows).toContain('Expand-Archive')
    expect(windows).not.toMatch(/cygpath|bash\.exe/)
  })

  it('overrides competing installer origins without disabling checksum verification', () => {
    const env = { ELECTRON_MIRROR: 'https://github.com/old/', NPM_CONFIG_ELECTRON_MIRROR: 'https://example.org/', ELECTRON_CUSTOM_FILENAME: 'unreviewed.zip' }
    configureVendorDownloads(env)
    expect(env.ELECTRON_MIRROR).toBe(origin + 'electron/')
    expect(env.NPM_CONFIG_ELECTRON_MIRROR).toBe(origin + 'electron/')
    expect(env).not.toHaveProperty('ELECTRON_CUSTOM_FILENAME')
    expect(env).not.toHaveProperty('ELECTRON_SKIP_BINARY_DOWNLOAD')
    expect(env).not.toHaveProperty('unsafelyDisableChecksums')
  })

  it('resolves the pinned Electron archive with the installed downloader despite inherited npm overrides', async () => {
    const electronRequire = createRequire(require_.resolve('electron/package.json'))
    const { getArtifactRemoteURL, getArtifactVersion } = await import(pathToFileURL(join(dirname(electronRequire.resolve('@electron/get')), 'artifact-utils.js')).href)
    const keys = [
      'npm_config_electron_customdir', 'NPM_CONFIG_ELECTRON_CUSTOM_DIR', 'npm_config_electron_custom_dir',
      'npm_package_config_electron_customDir', 'npm_package_config_electron_custom_dir', 'ELECTRON_CUSTOM_DIR',
      'npm_config_electron_customfilename', 'NPM_CONFIG_ELECTRON_CUSTOM_FILENAME', 'npm_config_electron_custom_filename',
      'npm_package_config_electron_customFilename', 'npm_package_config_electron_custom_filename', 'ELECTRON_CUSTOM_FILENAME',
      'npm_config_electron_customversion', 'NPM_CONFIG_ELECTRON_CUSTOM_VERSION', 'npm_config_electron_custom_version',
      'npm_package_config_electron_customVersion', 'npm_package_config_electron_custom_version', 'ELECTRON_CUSTOM_VERSION',
    ]
    const saved = { ...process.env }
    try {
      for (const key of keys) process.env[key] = 'old-mirror-layout'
      configureVendorDownloads()
      const details = { version: 'v44.0.0', platform: 'darwin', arch: 'arm64', artifactName: 'electron' }
      expect(await getArtifactRemoteURL(details)).toBe(origin + 'electron/v44.0.0/electron-v44.0.0-darwin-arm64.zip')
      expect(getArtifactVersion(details)).toBe('v44.0.0')
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
      Object.assign(process.env, saved)
    }
  })
})
