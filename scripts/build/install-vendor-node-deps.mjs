import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const sqliteVersion = JSON.parse(readFileSync(resolve(here, 'vendor-build-pins.json'), 'utf8')).sqliteVersion

/** SQLite 13 ships its N-API binaries in the integrity-locked npm package, without an installer download. */
export function verifySqliteNodeDependency(directory) {
  const require = createRequire(resolve(directory, 'package.json'))
  const manifest = require('better-sqlite3/package.json')
  const hasLifecycle = ['preinstall', 'install', 'postinstall', 'prepare'].some(name => manifest.scripts?.[name])
  if (manifest.version !== sqliteVersion || manifest.gypfile !== false || hasLifecycle || manifest.dependencies?.['prebuild-install']) {
    throw new Error('Unreviewed SQLite npm package or install lifecycle')
  }
  const Database = require('better-sqlite3')
  const database = new Database(':memory:')
  try {
    if (database.prepare('SELECT 1 AS ready').get().ready !== 1) throw new Error('SQLite N-API runtime probe failed')
  } finally { database.close() }
}

export function installVendorNodeDependencies(directory, args = []) {
  const run = commandArgs => {
    const result = spawnSync('npm', commandArgs, { cwd: directory, stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`npm dependency phase failed (${result.status ?? 'unknown'})`)
  }
  // npm verifies package-lock integrity. No remote prebuild installer or lifecycle is needed for SQLite 13.
  run(['install', ...args, '--ignore-scripts'])
  verifySqliteNodeDependency(directory)
  // SQLite has no lifecycle (including npm's implicit binding.gyp hook). Other packages still need
  // theirs: notably node-pty's install/postinstall produce its native module and spawn helper.
  run(['rebuild', '--ignore-scripts=false', '--workspaces=false', '--no-audit', '--no-fund'])
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installVendorNodeDependencies(resolve(here, '../../apps/desktop/session-tooling/node-deps'), ['--workspaces=false'])
}
