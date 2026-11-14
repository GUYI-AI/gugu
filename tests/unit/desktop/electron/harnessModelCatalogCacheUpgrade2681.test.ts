import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'

const stored = vi.hoisted(() => new Map<string, string>())
vi.mock('drizzle-orm', async (original) => ({
  ...await original<typeof import('drizzle-orm')>(),
  eq: (_column: unknown, value: string) => ({ value }),
}))
vi.mock('@main/db/schema', () => ({ appSettings: { key: 'key' } }))
vi.mock('@main/db/client', () => ({ db: {
  select: () => ({ from: () => ({ where: ({ value }: { value: string }) => ({
    execute: async () => stored.has(value) ? [{ value: stored.get(value) }] : [],
  }) }) }),
  insert: () => ({ values: (row: { key: string; value: string }) => ({
    onConflictDoUpdate: () => ({ execute: async () => { stored.set(row.key, row.value) } }),
  }) }),
} }))
vi.mock('../../../../apps/desktop/electron/session/main/core/agents/plugin-registry', () => ({
  getPlugin: () => ({ capabilities: { sessionBundle: {} } }),
}))

it('re-probes instead of reusing a fresh empty catalog written by the flat-only decoder', async () => {
  const legacy = JSON.stringify({ dsh: {
    state: { kind: 'ready', models: [], selected: null, efforts: [], selectedEffort: null },
    inputsHash: null, probedAt: Date.now(),
  } })
  stored.set('harnessModelCatalogs', legacy)
  const catalog = await import('../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog')
  const { wireHarnessModelCatalog } = await import('../../../../apps/desktop/electron/session/main/core/agents/harness-model-catalog-wiring')
  const dir = await mkdtemp(join(tmpdir(), 'gugu-grouped-catalog-upgrade-'))
  const entry = join(dir, 'agent.mjs')
  await writeFile(entry, `
import readline from 'node:readline';
for await (const line of readline.createInterface({ input: process.stdin })) {
  const m = JSON.parse(line);
  const reply = result => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ protocolVersion: 1, agentCapabilities: {} });
  if (m.method === 'session/new') reply({ sessionId: 'new-catalog', configOptions: [{
    id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: 'own',
    options: [{ group: 'provider', name: 'Provider', options: [{ value: 'own', name: 'Own model' }] }]
  }] });
}
`)
  wireHarnessModelCatalog()
  const spawn = vi.fn(async () => ({ command: process.execPath, args: [entry], env: {} }))
  catalog.setAcpSpawnResolver(spawn)
  catalog.setSpawnIdentityResolver(async () => null)
  try {
    const state = await catalog.getHarnessModelCatalog('dsh', { leg: 'acp', harnessVersion: null })
    expect(state).toMatchObject({ kind: 'ready', models: [{ id: 'own', name: 'Own model' }] })
    expect(spawn).toHaveBeenCalledTimes(1)
    expect(stored.get('harnessModelCatalogs')).toBe(legacy)
    expect([...stored.keys()].filter((key) => key !== 'harnessModelCatalogs')).toHaveLength(1)
  } finally {
    await catalog.__drainProbesForTest()
    catalog.setCatalogStore(null)
    catalog.__resetHarnessModelCatalogCache()
    await rm(dir, { recursive: true, force: true })
  }
})
