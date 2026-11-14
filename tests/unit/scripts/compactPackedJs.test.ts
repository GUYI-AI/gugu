import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { afterEach, describe, expect, it } from 'vitest'

const require = createRequire(import.meta.url)
const { compactPackedJs, emittedPackageImports } = require('../../../scripts/build/compact-packed-js.cjs')
const temporary: string[] = []

function put(root: string, file: string, content: string) {
  const target = path.join(root, file)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, content)
  return target
}

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'packed-js-'))
  temporary.push(root)
  const pkg = (name: string, manifest: object = {}, parent = root) => {
    const directory = path.join(parent, 'node_modules', name)
    put(directory, 'package.json', JSON.stringify({ name, version: '1.0.0', ...manifest }))
    put(directory, 'index.js', 'module.exports = "original filesystem package"')
    return directory
  }
  for (const name of ['node-pty', '@parcel/watcher', '@playwright/mcp', 'playwright-core', 'zcode-acp-server', '@gugu-acp/compat', '@anthropic-ai/claude-agent-sdk']) pkg(name)
  const native = pkg('better-sqlite3', { dependencies: { 'native-glue': '1' } })
  put(native, 'index.js', 'module.exports = require("native-glue")')
  put(pkg('native-glue'), 'index.js', 'module.exports = "native resolver closure"')
  const npm = pkg('npm')
  put(npm, 'node_modules/private-bundled-dep/src/node-gyp.cc', 'npm source must stay byte-for-byte')
  const adapter = pkg('@agentclientprotocol/claude-agent-acp', { type: 'module', dependencies: { 'pure-fixture': '1', '@anthropic-ai/claude-agent-sdk': '2' } })
  const sdk = pkg('@anthropic-ai/claude-agent-sdk', { type: 'module', main: 'sdk.mjs', peerDependencies: { zod: '1' } }, adapter)
  put(pkg('zod', { type: 'module' }, sdk), 'index.js', 'export const state = {}; export default state')
  put(sdk, 'peer-helper.mjs', 'export { state } from "zod"')
  put(sdk, 'sdk.mjs', 'import fs from "node:fs"; import state from "zod"; import { state as other } from "./peer-helper.mjs"; if (state !== other) throw new Error("duplicate peer instance"); export const asset = fs.readFileSync(new URL("asset.txt", import.meta.url), "utf8")')
  put(sdk, 'asset.txt', 'SDK asset at its real path')
  put(pkg('pure-fixture', {}, adapter), 'index.js', 'const os = require("node:os"); if (!os.tmpdir()) throw new Error("native require unavailable"); exports.value = { text: "bundled Claude" }')
  put(adapter, 'dist/lib.js', 'export { value } from "pure-fixture"')
  put(adapter, 'dist/index.js', 'import { value } from "./lib.js"; import { asset } from "@anthropic-ai/claude-agent-sdk"; console.log(value.text + ":" + asset)')
  const pi = pkg('pi-acp', { type: 'module', dependencies: { 'pure-fixture': '2' } })
  put(pkg('pure-fixture', { type: 'module' }, pi), 'index.js', 'export const text = "bundled Pi with its own dependency version"')
  put(pi, 'dist/index.js', 'import { text } from "pure-fixture"; console.log(text)')
  put(pkg('unused-pure'), 'LICENSE', 'A dependency notice retained after bundling')
  pkg('literal-helper')
  pkg('minified-helper')
  put(root, 'apps/desktop/dist-electron/worker.mjs', 'import { createRequire as cr } from "node:module"; let r; r = cr(import.meta.url); r.resolve("minified-helper")')
  put(root, 'apps/desktop/dist-electron/main.js', `
    const { createRequire } = require('node:module');
    const requireHere = createRequire(__filename);
    requireHere.resolve('literal-helper');
    try { require('optional-missing'); } catch {}
    const text = "require('not-a-real-import')";
    // require('also-not-a-real-import')
    console.log(require('better-sqlite3'));
  `)
  return root
}

afterEach(() => {
  for (const directory of temporary.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

describe('packed Windows JavaScript', () => {
  it('bundles separate ACP dependency versions while retaining bare-Node entry paths and filesystem closures', async () => {
    const root = fixture()
    const npmSource = path.join(root, 'node_modules/npm/node_modules/private-bundled-dep/src/node-gyp.cc')
    const originalNpm = fs.readFileSync(npmSource)
    const result = await compactPackedJs({ appDir: root })
    await compactPackedJs({ appDir: root })
    const run = (relative: string) => execFileSync(process.execPath, [path.join(root, relative)], { encoding: 'utf8' }).trim()
    expect(run('node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js')).toBe('bundled Claude:SDK asset at its real path')
    expect(run('node_modules/pi-acp/dist/index.js')).toBe('bundled Pi with its own dependency version')
    expect(run('apps/desktop/dist-electron/main.js')).toBe('native resolver closure')
    expect(fs.readFileSync(npmSource)).toEqual(originalNpm)
    expect(fs.existsSync(path.join(root, 'node_modules/unused-pure'))).toBe(false)
    expect(fs.existsSync(path.join(root, 'node_modules/pi-acp/node_modules/pure-fixture'))).toBe(false)
    expect(result.removedPackages).toContain(path.join('node_modules', 'unused-pure'))
    expect(fs.readFileSync(path.join(root, 'node_modules/THIRD-PARTY-LICENSES.txt'), 'utf8')).toContain('A dependency notice retained after bundling')
  })

  it('parses emitted code without treating documentation or comments as executable imports', () => {
    const imports = emittedPackageImports(fixture())
    expect(imports.some((entry: { name: string }) => entry.name === 'literal-helper')).toBe(true)
    expect(imports.some((entry: { name: string }) => entry.name === 'minified-helper')).toBe(true)
    expect(imports.some((entry: { name: string }) => entry.name === 'not-a-real-import')).toBe(false)
    expect(imports.find((entry: { name: string }) => entry.name === 'optional-missing').optional).toBe(true)
  })

  it('rejects a missing required package before removing any dependency directory', async () => {
    const root = fixture()
    put(root, 'apps/desktop/dist-electron/worker.js', 'require("missing-worker-dependency")')
    await expect(compactPackedJs({ appDir: root })).rejects.toThrow('missing-worker-dependency')
    expect(fs.existsSync(path.join(root, 'node_modules/unused-pure'))).toBe(true)
  })

  it('retains the required dependency contract of a package whose pure peers were bundled', async () => {
    const root = fixture()
    put(root, 'node_modules/zcode-acp-server/package.json', JSON.stringify({ name: 'zcode-acp-server', dependencies: { 'missing-raw-dependency': '1' } }))
    await expect(compactPackedJs({ appDir: root })).rejects.toThrow('missing-raw-dependency')
  })
})
