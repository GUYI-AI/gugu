import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * DeepSeek Harness writes every `session/new` to disk at once and never deletes it over ACP, so each model-catalog
 * probe used to leave one untitled session in the user's dsh app. The probe spawn is the production one (the real
 * dsh plugin, the real wiring); only where the binary lives is stubbed, and the binary is a stand-in that stores
 * sessions the way dsh 0.2.1-rc.5 / 0.2.2-rc.3 do (measured 2026-11-16): under the `session-persistence-jsonl` root
 * of the last `--patch` that sets it, else `$DSH_HOME/sessions`.
 */
const spawnContext = vi.hoisted(() => ({ cli: '', home: '' }))
vi.mock('@main/db/client', () => ({ db: {} }))
vi.mock('../../../../apps/desktop/electron/session/main/core/acp/transport/local-acp-process-host', () => ({
  resolveLocalAcpSpawnContext: async () => ({
    cli: spawnContext.cli,
    agentEnv: { DSH_HOME: spawnContext.home },
    runContext: { env: { DSH_HOME: spawnContext.home } },
  }),
}))

const {
  __drainProbesForTest,
  __resetHarnessModelCatalogCache,
  probeHarnessModelCatalog,
  setAcpSpawnResolver,
} = await import('../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog')
const { resolveHarnessModelCatalogSpawn } = await import(
  '../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog-wiring'
)

const FAKE_DSH = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
let root = path.join(process.env.DSH_HOME, 'sessions');
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] !== '--patch') continue;
  for (const row of JSON.parse(fs.readFileSync(argv[i + 1], 'utf8'))) {
    if (row.id === 'session-persistence-jsonl' && row.config && row.config.root) root = row.config.root;
  }
}
let buf = '';
let n = 0;
process.stdin.on('data', (c) => {
  buf += c.toString();
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\\n');
    if (msg.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
    if (msg.method === 'session/new') {
      const id = 'probe-' + (++n);
      fs.mkdirSync(path.join(root, msg.params.cwd.replace(/\\//g, '-'), id), { recursive: true });
      reply({ sessionId: id, configOptions: [{ id: 'model', category: 'model', type: 'select', currentValue: 'deepseek-v4-flash',
        options: [{ value: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }] }] });
    }
  }
});
`

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'gugu-dsh-probe-'))
  spawnContext.home = join(dir, 'dsh-home')
  spawnContext.cli = join(dir, 'dsh')
  await writeFile(spawnContext.cli, FAKE_DSH)
  await chmod(spawnContext.cli, 0o755)
  __resetHarnessModelCatalogCache()
  setAcpSpawnResolver(resolveHarnessModelCatalogSpawn)
})

afterEach(async () => {
  await __drainProbesForTest()
  setAcpSpawnResolver(async () => null)
  await rm(dir, { recursive: true, force: true })
})

describe.skipIf(process.platform === 'win32')('dsh model-catalog probe', () => {
  it('reads the catalog without leaving a session in the user\'s DSH_HOME', async () => {
    const state = await probeHarnessModelCatalog('dsh', 'acp')
    expect(state).toMatchObject({ kind: 'ready', selected: 'deepseek-v4-flash' })
    // The stand-in creates its store only when it persists a session there.
    await expect(readdir(join(spawnContext.home, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
