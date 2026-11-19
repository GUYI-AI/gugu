import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ importHome: vi.fn(), values: new Map<string, unknown>(), prepare: vi.fn(), resolveCli: vi.fn(), spawnEnv: vi.fn(), signIn: vi.fn(), dispose: undefined as (() => void) | undefined }));
vi.mock('@gugu/session-plugins/agents', () => ({ pluginRegistry: { getAll: () => [{
  metadata: { id: 'codex', name: 'Codex' }, capabilities: { sessionBundle: { configRoot: {}, injectionMode: 'managed-config-root' } },
}], get: () => ({ capabilities: { sessionBundle: { configRoot: {}, injectionMode: 'managed-config-root' } } }) } }));
vi.mock('@gugu/session-core/agents/plugins/helpers', () => ({
  AgentHomeMigrationFailure: class extends Error {},
  AgentHomeSpaceError: class extends Error {},
  checkAgentHomeImportSpace: async () => {},
  AGENT_HISTORY_LIMIT: 1024 ** 3,
  readAgentHomePending: async () => null,
  planAgentHomeHistory: async () => ({ paths: [], issues: [], skipped: [], sessions: 0, sessionBytes: 0 }),
  resolveAgentHome: () => ({ providerId: 'codex', configRoot: '/managed', userConfigRoot: '/missing-source', importGroups: [{ id: 'settings' }] }),
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
vi.mock('@main/app/app-scope', () => ({ appScope: { add: (cleanup: () => void) => { state.dispose = cleanup; } } }));
vi.mock('@gugu/session-plugins/agents/codex-history', () => ({ prepareCodexHistory: state.prepare }));
vi.mock('@main/core/acp/transport/local-acp-process-host', () => ({ resolveLocalAgentCli: state.resolveCli }));
vi.mock('./agent-run-context', () => ({ resolveLocalAgentSpawnEnv: state.spawnEnv }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => ({}) }));
vi.mock('./harness-connections', () => ({ migrateOwnedHarnessAccounts: state.signIn }));
vi.mock('./agent-home', () => ({ setAgentHomeUpgradePreparation: vi.fn() }));
vi.mock('../../../../error-summary-reporting-host', () => ({ reportAgentHomeMigrationFailure: vi.fn() }));

beforeEach(() => {
  vi.resetModules(); state.values.clear(); state.importHome.mockReset(); state.prepare.mockReset(); state.resolveCli.mockReset(); state.spawnEnv.mockReset(); state.signIn.mockReset();
  state.resolveCli.mockResolvedValue('/selected/codex'); state.spawnEnv.mockResolvedValue({ PATH: '/selected', CODEX_HOME: '/source' });
  state.signIn.mockResolvedValue({ upgradeSignIn: 'copied', terminalNeedsSignIn: false, relogin: [] });
});

it('returns status while automatic history migration is still unfinished', async () => {
  state.importHome.mockReturnValue(new Promise(() => {}));
  const homes = await import('./agent-homes');
  homes.initializeAgentHomeUpgrade(true);
  await vi.waitFor(() => expect(state.importHome).toHaveBeenCalledOnce());
  const rows = await homes.scanAgentHomes(['codex']);
  expect(rows).toMatchObject([{ providerId: 'codex', needsImport: true, migration: true, migrationPreparation: { phase: 'copying' }, groups: [] }]);
}, 1000);


it('uses the selected CLI and final managed CODEX_HOME before migrating sign-in', async () => {
  const order: string[] = [];
  state.prepare.mockImplementation(async () => { order.push('prepare'); });
  state.signIn.mockImplementation(async () => { order.push('sign-in'); return { upgradeSignIn: 'copied', terminalNeedsSignIn: false, relogin: [] }; });
  state.importHome.mockImplementation(async (_home, options) => {
    order.push('published');
    await options.prepareAfterPublish();
    await options.afterCommit();
    return { marker: { migratedFrom: 'shared', groups: [], files: {} }, issues: [] };
  });
  const homes = await import('./agent-homes');
  homes.initializeAgentHomeUpgrade(true);
  await vi.waitFor(() => expect(state.signIn).toHaveBeenCalledOnce());
  expect(state.resolveCli).toHaveBeenCalledWith('codex', 'primary');
  expect(state.spawnEnv).toHaveBeenCalledWith('codex', 'version-probe');
  expect(state.prepare.mock.calls[0][0]).toEqual({ cli: '/selected/codex', env: { PATH: '/selected', CODEX_HOME: '/managed' } });
  expect(order).toEqual(['published', 'prepare', 'sign-in']);
});

it('aborts native preparation on shutdown without advancing to sign-in', async () => {
  state.prepare.mockImplementation((_ctx, { signal }) => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  state.importHome.mockImplementation(async (_home, options) => {
    await options.prepareAfterPublish();
    await options.afterCommit();
    throw new Error('must not finish after shutdown');
  });
  const homes = await import('./agent-homes');
  homes.initializeAgentHomeUpgrade(true);
  await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
  const signal = state.prepare.mock.calls[0][1].signal as AbortSignal;
  state.dispose!();
  expect(signal.aborted).toBe(true);
  await vi.waitFor(async () => expect((await homes.scanAgentHomes(['codex']))[0]?.migrationPreparation).toBeUndefined());
  expect(state.signIn).not.toHaveBeenCalled();
});
