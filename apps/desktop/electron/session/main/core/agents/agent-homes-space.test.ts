import { beforeEach, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => {
  class SpaceError extends Error { constructor(readonly space: { requiredBytes: number; availableBytes: number; shortfallBytes: number }) { super('space'); } }
  return { SpaceError, check: vi.fn(), importer: vi.fn(), prepare: undefined as undefined | ((id: string) => Promise<void>), markers: new Map<string, unknown>(), cleanup: vi.fn(), login: vi.fn() };
});
vi.mock('@gugu/session-plugins/agents', () => ({
  pluginRegistry: {
    getAll: () => ['codex', 'claude'].map((id) => ({ metadata: { id, name: id }, capabilities: { sessionBundle: { configRoot: {} } } })),
    get: () => ({ capabilities: { sessionBundle: { configRoot: {} } } }),
  },
}));
vi.mock('@gugu/session-core/agents/plugins/helpers', () => ({
  AgentHomeSpaceError: state.SpaceError, AgentHomeMigrationFailure: class extends Error {},
  checkAgentHomeImportSpace: state.check,
  resolveAgentHome: ({ providerId }: { providerId: string }) => ({
    providerId, userConfigRoot: '/source/' + providerId, configRoot: '/managed/' + providerId,
    shadowHome: '/managed/' + providerId, importGroups: [{ id: 'skills', paths: ['skills/'] }],
    upgradeHistory: ['sessions'], legacyCleanup: [{ path: 'settings', update: () => {} }],
  }),
  readAgentHomeMarker: async ({ providerId }: { providerId: string }) => state.markers.get(providerId) ?? null,
  importAgentHome: state.importer, updateAgentHomeSource: state.cleanup,
  scanAgentHome: vi.fn(), diffAgentHome: vi.fn(), reimportAgentHome: vi.fn(),
}));
vi.mock('@main/db/client', () => ({ db: {} }));
vi.mock('@main/db/schema', () => ({ sessions: {} }));
vi.mock('@main/db/kv', () => ({ KV: class { async get(key: string) { return key === 'providers' ? ['codex', 'claude'] : {}; } } }));
vi.mock('@main/core/dependencies/dependency-managers', () => ({ ensureAgentDependenciesProbed: vi.fn(), localDependencyManager: {} }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => ({}) }));
vi.mock('./harness-connections', () => ({ migrateOwnedHarnessAccounts: state.login }));
vi.mock('./agent-home', () => ({ setAgentHomeUpgradePreparation: (prepare: typeof state.prepare) => { state.prepare = prepare; } }));
vi.mock('../../../../error-summary-reporting-host', () => ({ reportAgentHomeMigrationFailure: vi.fn() }));
beforeEach(() => { vi.resetModules(); state.check.mockReset(); state.importer.mockReset(); state.cleanup.mockReset(); state.login.mockReset(); state.markers.clear(); state.prepare = undefined; });

it('defers all pending providers before source cleanup or sign-in and does not reject session preparation', async () => {
  const space = { requiredBytes: 4_000_000_000, availableBytes: 1_000_000_000, shortfallBytes: 3_000_000_000 };
  state.check.mockRejectedValue(new state.SpaceError(space));
  const api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(true);
  await expect(state.prepare!('codex')).resolves.toBeUndefined();
  await expect(state.prepare!('claude')).resolves.toBeUndefined();
  const rows = await api.scanAgentHomes(undefined, true);
  expect(rows.map(({ providerId, migrationSpace }) => ({ providerId, migrationSpace }))).toEqual([
    { providerId: 'codex', migrationSpace: space }, { providerId: 'claude', migrationSpace: space },
  ]);
  expect(state.check).toHaveBeenCalledTimes(1);
  expect(state.check.mock.calls[0]![0]).toHaveLength(2);
  expect(state.cleanup).not.toHaveBeenCalled();
  expect(state.importer).not.toHaveBeenCalled();
  expect(state.login).not.toHaveBeenCalled();
});

it('retries automatic migration on a new startup after space becomes available', async () => {
  state.check.mockRejectedValue(new state.SpaceError({ requiredBytes: 10, availableBytes: 0, shortfallBytes: 10 }));
  let api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(true);
  await state.prepare!('codex'); await state.prepare!('claude');
  expect(state.importer).not.toHaveBeenCalled();
  vi.resetModules();
  state.check.mockResolvedValue(undefined);
  state.importer.mockImplementation(async (home) => {
    const marker = { migratedFrom: 'shared', files: {}, groups: ['skills'] };
    state.markers.set(home.providerId, marker);
    return { marker, issues: [] };
  });
  api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(true);
  await state.prepare!('codex'); await state.prepare!('claude');
  expect(state.importer).toHaveBeenCalledTimes(2);
});
