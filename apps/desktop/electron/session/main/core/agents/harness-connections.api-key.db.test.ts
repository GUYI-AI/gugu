import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { composeAgentSpawnEnv, type AgentRunContext } from '@gugu/session-core/agents/agent-run-context';
import { openRegistryFixture, type RegistryFixture } from '@tooling/utils/provider-accounts';
const state = vi.hoisted(() => ({ fixture: null as RegistryFixture | null, home: '' }));
vi.mock('@main/db/client', () => ({ get db() { return state.fixture!.db; } }));
vi.mock('@main/core/provider-accounts/provider-account-registry-instance', () => ({ get providerAccountRegistry() { return state.fixture!.registry; } }));
vi.mock('electron', () => ({ app: { getPath: () => state.home } }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
const { createHarnessConnection, renameHarnessConnection, harnessHasConnections, listHarnessConnections, resolveHarnessConnection, selectHarnessConnection } = await import('./harness-connections');
const { listCustomModels } = await import('./custom-models');
beforeEach(async () => { state.home = await mkdtemp(join(tmpdir(), 'gugu-vendor-account-')); state.fixture = await openRegistryFixture('empty'); });
afterEach(async () => { state.fixture?.close(); state.fixture = null; await rm(state.home, { recursive: true, force: true }); });
it('only OAuth account holders and vendor-key accounts have subscription connections', () => {
  for (const id of ['claude', 'codex', 'kilocode', 'mimocode']) expect(harnessHasConnections(id), id).toBe(true);
  for (const id of ['qwen', 'dsh', 'copilot', 'zcode', 'hermes', 'pi', 'opencode', 'codebuddy', 'antigravity', 'kiro']) expect(harnessHasConnections(id), id).toBe(false);
});
it.each([['kilocode', 'KILO_API_KEY'], ['mimocode', 'XIAOMI_API_KEY']])('%s keeps its vendor key in its own namespace and overrides inherited credentials', async (providerId, envVar) => {
  const saved = await createHarnessConnection({ providerId, kind: 'account', apiKey: 'selected-key', name: 'Work' });
  await selectHarnessConnection(providerId, saved.id);
  expect(await listHarnessConnections(providerId)).toContainEqual({ ...saved, current: true });
  const stored = await state.fixture!.registry.getAccount(`harness:${providerId}`, saved.id);
  expect(stored?.meta).toMatchObject({ credentialSource: 'vendor-key', harnessConnection: { kind: 'api-key' } });
  const context = await resolveHarnessConnection(providerId, { connectionId: saved.id });
  const run = { cli: { kind: 'unresolved', message: 'test' }, env: { [envVar]: 'inherited-other-key' }, pinnedEnv: {}, configRootEnv: {}, extraArgs: [], ...context } as AgentRunContext;
  expect(composeAgentSpawnEnv(run)[envVar]).toBe('selected-key');
  expect(context.vendorKeyAccount).toBe(true);
  expect(JSON.stringify(await listHarnessConnections(providerId))).not.toContain('selected-key');
  expect(await listCustomModels()).toEqual([]);
});
it('existing vendor rows migrate their semantics without copying their credential reference', async () => {
  await state.fixture!.registry.upsertAccount({ providerId: 'harness:kilocode', accountId: 'old', secret: 'key', meta: { harnessConnection: { kind: 'api-key' } } });
  const old = await state.fixture!.registry.getAccount('harness:kilocode', 'old');
  await listCustomModels();
  const row = await state.fixture!.registry.getAccount('harness:kilocode', 'old');
  expect(row?.credentialRef).toBe(old!.credentialRef);
  expect(row?.meta).toMatchObject({ credentialSource: 'vendor-key', harnessConnection: { kind: 'api-key' } });
  expect(await listHarnessConnections('kilocode')).toContainEqual(expect.objectContaining({ id: 'old', kind: 'account' }));
});

it('renames only device-owned metadata without changing a key, its reference or the selected account', async () => {
  const saved = await createHarnessConnection({ providerId: 'kilocode', kind: 'account', apiKey: 'fixture-secret', name: 'Before' });
  await selectHarnessConnection('kilocode', saved.id);
  const before = await state.fixture!.registry.getAccount('harness:kilocode', saved.id);
  expect(await renameHarnessConnection({ providerId: 'kilocode', connectionId: saved.id, name: '  After  ' }))
    .toEqual({ ...saved, name: 'After', current: true });
  const after = await state.fixture!.registry.getAccount('harness:kilocode', saved.id);
  expect(after?.credentialRef).toBe(before?.credentialRef);
  expect(after?.meta).toEqual({ ...before?.meta, displayName: 'After' });
  expect(after?.isDefault).toBe(before?.isDefault);
  expect(await state.fixture!.registry.resolveSecret('harness:kilocode', saved.id)).toBe('fixture-secret');
  await expect(renameHarnessConnection({ providerId: 'mimocode', connectionId: saved.id, name: 'Other provider' })).rejects.toThrow('no longer exists');
  await expect(renameHarnessConnection({ providerId: 'kilocode', connectionId: saved.id, name: ' ' })).rejects.toThrow('1–80');
});
it('does not recreate deleted connections when renaming', async () => {
  await state.fixture!.registry.upsertAccount({ providerId: 'harness:kilocode', accountId: 'removed', secret: 'fixture-secret', meta: { harnessConnection: { kind: 'api-key', removed: true } } });
  await expect(renameHarnessConnection({ providerId: 'kilocode', connectionId: 'removed', name: 'Recreated' })).rejects.toThrow('no longer exists');
  expect((await state.fixture!.registry.getAccount('harness:kilocode', 'removed'))?.meta?.harnessConnection?.removed).toBe(true);
});
