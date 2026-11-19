import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const require_ = createRequire(import.meta.url)
const { loadedNativePath, serverNativePaths } = require_('../../../scripts/gugu-server/loaded-native-paths.cjs') as {
  loadedNativePath(packageDirectory: string, cache: Record<string, unknown>): string
  serverNativePaths(appDirectory: string): string[]
}

describe('server smoke inspects the native binary actually loaded', () => {
  const root = resolve('/package/app/node_modules/better-sqlite3')

  it.each(['prebuilds/linux-x64.node', 'prebuilds/linux-arm64.node', 'build/Release/better_sqlite3.node'])(
    'selects the loaded %s without assuming a build directory', path => {
      const binary = resolve(root, path)
      expect(loadedNativePath(root, { [binary]: {} })).toBe(binary)
    },
  )

  it('ignores another package, a same-prefix sibling and JS entries', () => {
    const binary = resolve(root, 'prebuilds/linux-x64.node')
    expect(loadedNativePath(root, {
      [binary]: {},
      [resolve(`${root}-other`, 'foreign.node')]: {},
      [resolve(root, 'lib/index.js')]: {},
      [resolve(root, '../node-pty/build/Release/pty.node')]: {},
    })).toBe(binary)
  })

  it('refuses a missing binary instead of scanning an unused platform prebuild', () => {
    expect(() => loadedNativePath(root, {})).toThrow('found 0')
  })

  it('refuses ambiguous loaded native binaries', () => {
    expect(() => loadedNativePath(root, {
      [resolve(root, 'prebuilds/linux-x64.node')]: {},
      [resolve(root, 'build/Release/better_sqlite3.node')]: {},
    })).toThrow('found 2')
  })

  it('refuses a missing packaged app before resolving any build-machine dependencies', () => {
    expect(() => serverNativePaths(resolve('/missing-server-app-for-native-probe'))).toThrow()
  })

  it('rejects modules resolved from the build machine above the packaged app', () => {
    const directory = mkdtempSync(join(tmpdir(), 'server-native-owner-'))
    try {
      const app = join(directory, 'app')
      mkdirSync(app)
      writeFileSync(join(app, 'package.json'), '{}')
      const parentPackage = join(directory, 'node_modules', 'better-sqlite3')
      mkdirSync(parentPackage, { recursive: true })
      writeFileSync(join(parentPackage, 'package.json'), JSON.stringify({ name: 'better-sqlite3', version: '13.2.0' }))
      expect(() => serverNativePaths(app)).toThrow('better-sqlite3 resolved outside the packaged app')
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
