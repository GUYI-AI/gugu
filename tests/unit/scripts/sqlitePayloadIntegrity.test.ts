import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

type Payload = Readonly<Record<string, string>>
const { assertSqlitePayload, sqlitePayloadSnapshot } = await import(pathToFileURL(resolve(__dirname, '../../../scripts/build/sqlite-payload-integrity.mjs')).href) as {
  assertSqlitePayload(directory: string, expected: Payload, expectedEntry: string): string
  sqlitePayloadSnapshot(directory: string): Payload
}
const { installServerNodeDependencies } = await import(pathToFileURL(resolve(__dirname, '../../../scripts/build/install-vendor-node-deps.mjs')).href) as {
  installServerNodeDependencies(directory: string, args: string[], options: { run(directory: string, args: string[]): void }): void
}

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'sqlite-payload-integrity-'))
  roots.push(root)
  const trusted = join(root, 'trusted')
  const app = join(root, 'app')
  const installed = join(app, 'node_modules/better-sqlite3')
  mkdirSync(join(trusted, 'prebuilds'), { recursive: true })
  mkdirSync(app)
  writeFileSync(join(app, 'package.json'), JSON.stringify({ dependencies: { 'better-sqlite3': '13.2.0' } }))
  writeFileSync(join(trusted, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '13.2.0', gypfile: false, main: 'index.cjs' }))
  writeFileSync(join(trusted, 'index.cjs'), 'module.exports = {}')
  writeFileSync(join(trusted, 'prebuilds/linux-x64.node'), 'synthetic native payload')
  const expected = sqlitePayloadSnapshot(trusted)
  cpSync(trusted, installed, { recursive: true })
  return { root, trusted, app, installed, expected }
}

describe('SQLite payload binding from reviewed extraction to the installed app', () => {
  it('accepts identical bytes in a separate installed directory', () => {
    const f = fixture()
    expect(assertSqlitePayload(f.app, f.expected, 'index.cjs')).toBe(realpathSync(join(f.installed, 'index.cjs')))
  })

  it.each(['index.cjs', 'prebuilds/linux-x64.node'])('rejects changed %s while the manifest version stays the same', file => {
    const f = fixture()
    writeFileSync(join(f.installed, file), 'changed payload')
    expect(JSON.parse(readFileSync(join(f.installed, 'package.json'), 'utf8')).version).toBe('13.2.0')
    expect(() => assertSqlitePayload(f.app, f.expected, 'index.cjs')).toThrow('differs from the committed-lock payload')
  })

  it.each(['extra', 'missing'])('rejects an %s payload file', kind => {
    const f = fixture()
    if (kind === 'extra') writeFileSync(join(f.installed, 'extra.cjs'), 'unexpected')
    else rmSync(join(f.installed, 'index.cjs'))
    expect(() => assertSqlitePayload(f.app, f.expected, 'index.cjs')).toThrow()
  })

  it.each(['index.cjs', 'prebuilds/linux-x64.node'])('stops before any package require or rebuild when installed %s is changed', file => {
    const f = fixture()
    const loaded = join(f.root, 'package-was-loaded')
    // Model the npm ci extraction. No real SQLite/native code or external package is executed here.
    writeFileSync(join(f.trusted, 'index.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(loaded)}, 'loaded'); module.exports = class { prepare(){return {get(){return {ready:1}}}} close(){} }`)
    const phases: string[] = []
    expect(() => installServerNodeDependencies(f.app, ['--no-package-lock'], { run(cwd: string, args: string[]) {
      phases.push(args[0])
      if (args[0] === 'ci') cpSync(f.trusted, join(cwd, 'node_modules/better-sqlite3'), { recursive: true })
      if (args[0] === 'install') {
        rmSync(f.installed, { recursive: true })
        cpSync(join(f.app, '.sqlite-node-deps/node_modules/better-sqlite3'), f.installed, { recursive: true })
        writeFileSync(join(f.installed, file), 'changed after extraction')
      }
    } })).toThrow('differs from the committed-lock payload')
    expect(phases).toEqual(['ci', 'install'])
    expect(existsSync(loaded)).toBe(false)
  })

  it('stops immediately when the committed-lock installation fails', () => {
    const f = fixture()
    const phases: string[] = []
    expect(() => installServerNodeDependencies(f.app, [], { run(_cwd: string, args: string[]) {
      phases.push(args[0])
      throw new Error('npm ci integrity rejected')
    } })).toThrow('npm ci integrity rejected')
    expect(phases).toEqual(['ci'])
  })

  it.each(['./unchecked.cjs', './checked/other.cjs'])(
    'rejects a package.json export alias to checked bytes while the actual entry is %s, before loading it', target => {
      const f = fixture()
      const loaded = join(f.root, 'unchecked-was-loaded')
      writeFileSync(join(f.trusted, 'other.cjs'), 'module.exports = {}')
      const phases: string[] = []
      expect(() => installServerNodeDependencies(f.app, [], { run(cwd: string, args: string[]) {
        phases.push(args[0])
        if (args[0] === 'ci') cpSync(f.trusted, join(cwd, 'node_modules/better-sqlite3'), { recursive: true })
        if (args[0] === 'install') {
          rmSync(f.installed, { recursive: true })
          mkdirSync(f.installed)
          cpSync(join(f.app, '.sqlite-node-deps/node_modules/better-sqlite3'), join(f.installed, 'checked'), { recursive: true })
          writeFileSync(join(f.installed, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '13.2.0', exports: {
            './package.json': './checked/package.json', '.': target,
          } }))
          writeFileSync(join(f.installed, 'unchecked.cjs'), `require('node:fs').writeFileSync(${JSON.stringify(loaded)}, 'loaded'); throw Error('unchecked entry ran')`)
        }
      } })).toThrow('SQLite entry is outside the verified payload or differs from the committed-lock entry')
      expect(phases).toEqual(['ci', 'install'])
      expect(existsSync(loaded)).toBe(false)
    },
  )

  it('refuses a payload changed by a later dependency lifecycle before packaging', () => {
    const f = fixture()
    writeFileSync(join(f.trusted, 'index.cjs'), 'module.exports = class { prepare(){return {get(){return {ready:1}}}} close(){} }')
    const phases: string[] = []
    expect(() => installServerNodeDependencies(f.app, [], { run(cwd: string, args: string[]) {
      phases.push(args[0])
      if (args[0] === 'ci') cpSync(f.trusted, join(cwd, 'node_modules/better-sqlite3'), { recursive: true })
      if (args[0] === 'install') {
        rmSync(f.installed, { recursive: true })
        cpSync(join(f.app, '.sqlite-node-deps/node_modules/better-sqlite3'), f.installed, { recursive: true })
      }
      if (args[0] === 'rebuild') writeFileSync(join(f.installed, 'index.cjs'), 'changed by lifecycle')
    } })).toThrow('differs from the committed-lock payload')
    expect(phases).toEqual(['ci', 'install', 'rebuild'])
  })
})
