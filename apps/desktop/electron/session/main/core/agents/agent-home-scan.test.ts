import { expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ importHome: vi.fn(), values: new Map<string, unknown>() }));
vi.mock('@gugu/session-plugins/agents', () => ({ pluginRegistry: { getAll: () => [{
  metadata: { id: 'codex', name: 'Codex' }, capabilities: { sessionBundle: { configRoot: {}, injectionMode: 'managed-config-root' } },
}], get: () => ({ capabilities: { sessionBundle: { configRoot: {}, injectionMode: 'managed-config-root' } } }) } }));
vi.mock('@gugu/session-core/agents/plugins/helpers', () => ({
  AgentHomeMigrationFailure: class extends Error {},
  resolveAgentHome: () => ({ configRoot: '/managed', userConfigRoot: '/missing-source', importGroups: [{ id: 'settings' }] }),
  readAgentHomeMarker: async () => null,
  scanAgentHome: async () => ({ marker: null, newestMtime: 0, groups: [{ id: 'settings', count: 1, mcpCount: 0 }], issues: [], mcpSecrets: [], mcpNames: [], projectMcpCount: 0 }),
  importAgentHome: state.importHome,
}));
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: () => ({ all: () => [] }) }) }) }) } }));
vi.mock('@main/db/schema', () => ({ sessions: { id: 'id', provider: 'provider' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('@main/db/kv', () => ({ KV: class { get(key: string) { return Promise.resolve(state.values.get(key)); } setOrThrow(key: string, value: unknown) { state.values.set(key, value); return Promise.resolve(); } } }));
vi.mock('@main/core/dependencies/dependency-managers', () => ({ ensureAgentDependenciesProbed: async () => {}, localDependencyManager: { get: () => ({ status: 'available' }) } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => ({}) }));
vi.mock('./harness-connections', () => ({ migrateOwnedHarnessAccounts: vi.fn() }));
vi.mock('./agent-home', () => ({ setAgentHomeUpgradePreparation: vi.fn() }));
vi.mock('../../../../error-summary-reporting-host', () => ({ reportAgentHomeMigrationFailure: vi.fn() }));

it('returns status while automatic history migration is still unfinished', async () => {
  state.importHome.mockReturnValue(new Promise(() => {}));
  const homes = await import('./agent-homes');
  homes.initializeAgentHomeUpgrade(true);
  await vi.waitFor(() => expect(state.importHome).toHaveBeenCalledOnce());
  const rows = await homes.scanAgentHomes(['codex']);
  expect(rows).toMatchObject([{ providerId: 'codex', needsImport: true, migration: true, groups: [{ id: 'settings', count: 1 }] }]);
}, 1000);
