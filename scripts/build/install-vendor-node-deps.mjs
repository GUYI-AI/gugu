import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = JSON.parse(readFileSync(resolve(here, 'prebuild-install-source.json'), 'utf8'))
const digest = bytes => createHash('sha256').update(bytes).digest('hex')

/** Npm's isolated trees do not apply pnpm patches. Guard their installer before any lifecycle. */
export function guardNpmPrebuilds(directory) {
  const require = createRequire(resolve(directory, 'package.json'))
  const sqlite = createRequire(require.resolve('better-sqlite3/package.json'))
  const installerPackage = sqlite.resolve('prebuild-install/package.json')
  if (JSON.parse(readFileSync(installerPackage, 'utf8')).version !== '7.1.3') throw new Error('Unreviewed prebuild installer version')
  const installer = dirname(installerPackage)
  for (const [name, edit] of Object.entries(source)) {
    const file = resolve(installer, name)
    const original = readFileSync(file, 'utf8')
    // Repeated installs may retain the already guarded installer.
    if (digest(original) === edit.patchedSha256) continue
    if (digest(original) !== edit.sha256 || original.split(edit.before).length !== 2) throw new Error(`Unreviewed prebuild installer file: ${name}`)
    writeFileSync(file, original.replace(edit.before, edit.after))
  }
  writeFileSync(resolve(installer, 'gugu-vendor.js'), readFileSync(resolve(here, 'sqlite-prebuild-guard.cjs')))
}

export function installVendorNodeDependencies(directory, args = []) {
  const run = commandArgs => {
    const result = spawnSync('npm', commandArgs, { cwd: directory, stdio: 'inherit', shell: process.platform === 'win32' })
    if (result.error) throw result.error
    if (result.status !== 0) throw new Error(`npm dependency phase failed (${result.status ?? 'unknown'})`)
  }
  // Resolve the same npm dependencies first. Then run their original lifecycles with the guard in place.
  run(['install', ...args, '--ignore-scripts'])
  guardNpmPrebuilds(directory)
  run(['rebuild', '--ignore-scripts=false', '--workspaces=false', '--no-audit', '--no-fund'])
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  installVendorNodeDependencies(resolve(here, '../../apps/desktop/session-tooling/node-deps'), ['--workspaces=false'])
}
