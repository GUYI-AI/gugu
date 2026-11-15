import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { configureVendorDownloads } = require_('../../../scripts/build/vendor-download-env.cjs')
const origin = 'https://download.gugu.nextmind.space/releases/vendor/'
const { verifySqliteNodeDependency } = await import(pathToFileURL(resolve(__dirname, '../../../scripts/build/install-vendor-node-deps.mjs')).href) as {
  verifySqliteNodeDependency(directory: string): void
}

describe('installer archive boundaries', () => {
  it('loads the integrity-locked SQLite 13 npm package without a remote prebuild installer', () => {
    const directory = mkdtempSync(join(tmpdir(), 'sqlite-napi-install-'))
    try {
      const pkg = join(directory, 'node_modules/better-sqlite3')
      mkdirSync(pkg, { recursive: true })
      writeFileSync(join(directory, 'package.json'), '{}')
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '13.2.0', main: 'index.cjs' }))
      writeFileSync(join(pkg, 'index.cjs'), 'module.exports=class { prepare(){return {get(){return {ready:1}}}} close(){} }')
      expect(() => verifySqliteNodeDependency(directory)).not.toThrow()
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it.each([
    { version: '12.11.1' }, { version: '13.3.0' },
    { version: '13.2.0', scripts: { install: 'remote-prebuild-installer' } },
    { version: '13.2.0', dependencies: { 'prebuild-install': '7.1.3' } },
  ])('refuses an unreviewed SQLite version or lifecycle before native loading: %j', manifest => {
    const directory = mkdtempSync(join(tmpdir(), 'sqlite-napi-refuse-'))
    try {
      const pkg = join(directory, 'node_modules/better-sqlite3')
      mkdirSync(pkg, { recursive: true }); writeFileSync(join(directory, 'package.json'), '{}')
      writeFileSync(join(pkg, 'package.json'), JSON.stringify({ name: 'better-sqlite3', main: 'index.cjs', ...manifest }))
      writeFileSync(join(pkg, 'index.cjs'), 'throw Error("native code must not load")')
      expect(() => verifySqliteNodeDependency(directory)).toThrow('Unreviewed SQLite npm package or install lifecycle')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  it('keeps the root, session and isolated Node SQLite pins aligned without legacy archive downloads', () => {
    const root = resolve(__dirname, '../../..')
    const pins = JSON.parse(readFileSync(join(root, 'scripts/build/vendor-build-pins.json'), 'utf8'))
    for (const file of ['package.json', 'packages/session-core/package.json', 'apps/desktop/session-tooling/node-deps/package.json']) {
      expect(JSON.parse(readFileSync(join(root, file), 'utf8')).dependencies['better-sqlite3']).toBe(pins.sqliteVersion)
    }
    expect(pins.sqliteVersion).toBe('13.2.0')
    expect(pins.artifacts.filter((item: { component: string }) => item.component === 'better-sqlite3')).toEqual([])
    expect(readFileSync(join(root, 'scripts/build/install-vendor-node-deps.mjs'), 'utf8')).not.toContain('sqlite-prebuild-guard')
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
