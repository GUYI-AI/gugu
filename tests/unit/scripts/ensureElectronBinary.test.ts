import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

let root: string
beforeEach(() => { root = mkdtempSync(path.join(os.tmpdir(), 'gugu-electron-path-')) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

function runWithReturnedPath(binary: string) {
  const scripts = path.join(root, 'scripts/build')
  const fakeModule = path.join(root, 'node_modules/electron')
  mkdirSync(scripts, { recursive: true })
  mkdirSync(fakeModule, { recursive: true })
  for (const name of ['ensure-electron-binary.mjs', 'vendor-download-env.cjs']) {
    writeFileSync(path.join(scripts, name), readFileSync(path.resolve('scripts/build', name)))
  }
  writeFileSync(path.join(fakeModule, 'package.json'), JSON.stringify({ name: 'electron', main: 'index.cjs' }))
  writeFileSync(path.join(fakeModule, 'index.cjs'), `module.exports = ${JSON.stringify(binary)};\n`)
  return spawnSync(process.execPath, [path.join(scripts, 'ensure-electron-binary.mjs')], {
    cwd: root, env: process.env, encoding: 'utf8',
  })
}

describe('Electron executable availability after installation', () => {
  it('rejects a loader that returns a nonexistent override path without throwing', () => {
    const result = runWithReturnedPath(path.join(root, 'missing/electron'))
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('[ensure-electron-binary] ok')
    expect(result.stderr).toContain('Electron executable is missing or is not a file')
  })

  it('rejects a directory returned as an executable', () => {
    const result = runWithReturnedPath(root)
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('[ensure-electron-binary] ok')
  })

  it.skipIf(process.platform === 'win32')('rejects an existing file without execute permission', () => {
    const binary = path.join(root, 'not-executable')
    writeFileSync(binary, 'fixture', { mode: 0o600 })
    const result = runWithReturnedPath(binary)
    expect(result.status).toBe(1)
    expect(result.stdout).not.toContain('[ensure-electron-binary] ok')
  })

  it('accepts an existing executable returned by the loader', () => {
    const result = runWithReturnedPath(process.execPath)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain(`[ensure-electron-binary] ok → ${process.execPath}`)
  })
})
