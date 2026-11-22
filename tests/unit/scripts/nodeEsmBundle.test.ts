import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { build } from 'esbuild'
import { afterAll, expect, test } from 'vitest'
import { NODE_ESM_BUNDLE } from '../../../scripts/build/node-esm-bundle.mjs'

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'gugu-node-esm-bundle-'))
afterAll(() => fs.rmSync(out, { recursive: true, force: true }))

// The Codex adapter bundles `ws` (through the local transport), a CommonJS package that requires Node built-ins. Built
// the way the desktop build builds it, the adapter must get past module load; with no stdin it then exits on its own.
test('the Codex adapter bundle loads its CommonJS dependencies', async () => {
  const outfile = path.join(out, 'codex-app-server-acp.mjs')
  await build({ entryPoints: [path.resolve('apps/desktop/electron/runtime/codex-app-server-acp.mjs')], outfile, logLevel: 'silent', ...NODE_ESM_BUNDLE })
  const run = spawnSync(process.execPath, [outfile], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 20_000, env: { PATH: process.env.PATH ?? '' } })
  expect(run.stderr).not.toMatch(/Dynamic require of|require is not defined/)
}, 60_000)
