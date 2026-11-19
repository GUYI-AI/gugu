import { spawnSync } from 'node:child_process'
import { copyFileSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { assertSqlitePayload, sqlitePayloadSnapshot } from './sqlite-payload-integrity.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const sqliteVersion = JSON.parse(readFileSync(resolve(here, 'vendor-build-pins.json'), 'utf8')).sqliteVersion

/** SQLite 13 ships its N-API binaries in the integrity-locked npm package, without an installer download. */
export function verifySqliteNodeDependency(directory, verifiedEntry) {
  const require = createRequire(resolve(directory, 'package.json'))
  const manifest = require('better-sqlite3/package.json')
  const hasLifecycle = ['preinstall', 'install', 'postinstall', 'prepare'].some(name => manifest.scripts?.[name])
  if (manifest.version !== sqliteVersion || manifest.gypfile !== false || hasLifecycle || manifest.dependencies?.['prebuild-install']) {
    throw new Error('Unreviewed SQLite npm package or install lifecycle')
  }
  const Database = require(verifiedEntry ?? 'better-sqlite3')
  const database = new Database(':memory:')
  try {
    if (database.prepare('SELECT 1 AS ready').get().ready !== 1) throw new Error('SQLite N-API runtime probe failed')
  } finally { database.close() }
}

function runNpm(directory, args) {
  const result = spawnSync('npm', args, { cwd: directory, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`npm dependency phase failed (${result.status ?? 'unknown'})`)
}

export function installVendorNodeDependencies(directory, args = []) {
  // This caller has the committed isolated-Node lock; refuse drift instead of generating a new lock.
  runNpm(directory, ['ci', ...args, '--ignore-scripts'])
  verifySqliteNodeDependency(directory)
}

export function installServerNodeDependencies(directory, args = [], { run = runNpm } = {}) {
  const locked = resolve(directory, '.sqlite-node-deps')
  const reviewed = resolve(here, '../../apps/desktop/session-tooling/node-deps')
  mkdirSync(locked, { recursive: true })
  for (const file of ['package.json', 'package-lock.json']) copyFileSync(resolve(reviewed, file), resolve(locked, file))
  run(locked, ['ci', '--ignore-scripts', '--workspaces=false', '--no-audit', '--no-fund'])
  // The expected JS/native bytes come from npm ci's SRI-verified extraction of the committed lock,
  // never from the unreviewed server installation or a newly generated lock.
  const reviewedRequire = createRequire(resolve(locked, 'package.json'))
  const reviewedRoot = dirname(realpathSync(reviewedRequire.resolve('better-sqlite3/package.json')))
  const reviewedLock = JSON.parse(readFileSync(resolve(locked, 'package-lock.json'), 'utf8'))
  const expected = sqlitePayloadSnapshot(reviewedRoot)
  const expectedEntry = relative(reviewedRoot, realpathSync(reviewedRequire.resolve('better-sqlite3'))).split(sep).join('/')
  const manifestPath = resolve(directory, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  if (manifest.dependencies?.['better-sqlite3'] !== sqliteVersion) throw new Error('Server SQLite version differs from the reviewed pin')
  manifest.dependencies['better-sqlite3'] = 'file:./.sqlite-node-deps/node_modules/better-sqlite3'
  // node-pty needs node-addon-api 7, while SQLite's committed lock contains 8. Without an
  // explicit root binding npm hoists 7 and writes a nested 8 into the verified SQLite payload.
  // Pin the committed-lock version at the app root; npm can nest 7 under node-pty.
  manifest.dependencies['node-addon-api'] = reviewedLock.packages['node_modules/node-addon-api'].version
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  run(directory, ['install', ...args, '--ignore-scripts'])
  const entry = assertSqlitePayload(directory, expected, expectedEntry)
  verifySqliteNodeDependency(directory, entry)
  // SQLite has no lifecycle (including npm's implicit binding.gyp hook). Other packages still need
  // theirs: notably node-pty's install/postinstall produce its native module and spawn helper.
  run(directory, ['rebuild', '--ignore-scripts=false', '--workspaces=false', '--no-audit', '--no-fund'])
  assertSqlitePayload(directory, expected, expectedEntry)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installVendorNodeDependencies(resolve(here, '../../apps/desktop/session-tooling/node-deps'), ['--workspaces=false'])
}
