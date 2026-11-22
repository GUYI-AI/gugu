import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  root: '', oldTasks: false, kv: new Map<string, unknown>(), markers: new Map<string, unknown>(),
  importHome: vi.fn(), diff: vi.fn(), reimport: vi.fn(), probe: vi.fn(), report: vi.fn(), prepare: undefined as undefined | ((id: string) => Promise<void>),
}));
vi.mock('@gugu/session-plugins/agents', () => ({
  pluginRegistry: {
    getAll: () => ['codex', 'claude'].map((id) => ({ metadata: { id, name: id }, capabilities: { sessionBundle: { configRoot: {} } } })),
    get: () => ({ capabilities: { sessionBundle: { configRoot: {} } } }),
  },
}));
vi.mock('@gugu/session-core/agents/plugins/helpers', () => ({
  AgentHomeSpaceError: class extends Error {}, AgentHomeMigrationFailure: class extends Error {},
  AGENT_HISTORY_LIMIT: 4 * 1024 ** 3,
  resolveAgentHome: ({ providerId }: { providerId: string }) => ({
    providerId, userConfigRoot: join(state.root, '.' + providerId), configRoot: join(state.root, 'managed', providerId),
    importGroups: [{ id: 'settings', paths: ['config'] }],
  }),
  readAgentHomeMarker: async ({ providerId }: { providerId: string }) => state.markers.get(providerId) ?? null,
  readAgentHomePending: async () => null,
  scanAgentHome: async ({ providerId }: { providerId: string }) => ({
    marker: state.markers.get(providerId) ?? null, sourceUpdated: false,
    groups: [{ id: 'settings', count: 1 }], issues: [], mcpSecrets: [], projectMcpCount: 0,
  }),
  importAgentHome: state.importHome, diffAgentHome: state.diff, reimportAgentHome: state.reimport,
  planAgentHomeHistory: async () => ({ paths: [], issues: [], skipped: [], sessions: 0, sessionBytes: 0 }),
  checkAgentHomeImportSpace: async () => {},
}));
vi.mock('@main/app/app-scope', () => ({ appScope: { add: vi.fn() } }));
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: () => ({ all: () => state.oldTasks ? [{ id: 'old' }] : [] }) }) }) }) } }));
vi.mock('@main/db/schema', () => ({ sessions: {} }));
vi.mock('@main/db/kv', () => ({ KV: class {
  async get(key: string) { return state.kv.get(key) ?? null; }
  async setOrThrow(key: string, value: unknown) { state.kv.set(key, value); }
} }));
vi.mock('@main/core/dependencies/dependency-managers', () => ({
  ensureAgentDependenciesProbed: state.probe, localDependencyManager: { get: () => ({ status: 'available' }) },
}));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => ({}) }));
vi.mock('./harness-connections', () => ({ migrateOwnedHarnessAccounts: vi.fn() }));
vi.mock('./agent-home', () => ({ setAgentHomeUpgradePreparation: (prepare: typeof state.prepare) => { state.prepare = prepare; } }));
vi.mock('../../../../error-summary-reporting-host', () => ({ reportAgentHomeMigrationFailure: state.report }));

beforeEach(async () => {
  vi.resetModules(); state.kv.clear(); state.markers.clear(); state.oldTasks = false; vi.clearAllMocks();
  state.probe.mockResolvedValue(undefined);
  state.root = await mkdtemp(join(tmpdir(), 'gugu-first-install-'));
  state.importHome.mockImplementation(async ({ providerId }) => {
    const marker = { migratedFrom: 'shared', importedAt: 'fixture', files: {}, groups: ['settings'] };
    state.markers.set(providerId, marker);
    return { marker, issues: [] };
  });
});
afterEach(async () => { await rm(state.root, { recursive: true, force: true }); });

it('detects native records on a new installation without probing a CLI or copying anything', async () => {
  await mkdir(join(state.root, '.codex'));
  await writeFile(join(state.root, '.codex', 'config.toml'), 'model = "fixture"\n');
  await mkdir(join(state.root, '.claude'));
  const api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(false);
  const rows = await api.scanAgentHomes(undefined, false, true);
  expect(rows.map(({ providerId, needsImport, migration }) => ({ providerId, needsImport, migration }))).toEqual([
    { providerId: 'codex', needsImport: true, migration: false },
  ]);
  expect(state.probe).not.toHaveBeenCalled();
  expect(state.importHome).not.toHaveBeenCalled();
});

it('still offers unhandled records after restarting a fresh profile with a saved empty inventory', async () => {
  await mkdir(join(state.root, '.codex'));
  await writeFile(join(state.root, '.codex', 'config.toml'), 'fixture');
  let api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(false);
  await api.scanAgentHomes(undefined, false, true);
  expect(state.kv.get('inventory')).toEqual({ codex: false, claude: false });
  vi.resetModules();
  api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(false);
  expect((await api.scanAgentHomes(undefined, false, true)).map(({ providerId }) => providerId)).toEqual(['codex']);
  expect(state.importHome).not.toHaveBeenCalled();
});

it('leaves upgrade automatic imports in place and never offers the first-install prompt', async () => {
  const api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(true);
  await state.prepare!('codex'); await state.prepare!('claude');
  expect(state.importHome).toHaveBeenCalledTimes(2);
  expect(state.report).not.toHaveBeenCalled();
  expect(await api.scanAgentHomes(undefined, false, true)).toEqual([]);
});

it('treats an old task database as an upgrade even without the earlier profile record', async () => {
  state.oldTasks = true;
  const api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(false);
  await state.prepare!('codex'); await state.prepare!('claude');
  expect(state.importHome).toHaveBeenCalledTimes(2);
  expect(await api.scanAgentHomes(undefined, false, true)).toEqual([]);
});

it('does not offer missing directories or homes the person has already imported', async () => {
  await mkdir(join(state.root, '.codex'));
  await writeFile(join(state.root, '.codex', 'config.toml'), 'fixture');
  state.markers.set('codex', { importedAt: 'fixture' });
  const api = await import('./agent-homes');
  api.initializeAgentHomeUpgrade(false);
  expect(await api.scanAgentHomes(undefined, false, true)).toEqual([]);
  expect(state.importHome).not.toHaveBeenCalled();
});


it('routes an explicit repeated CLI import through revision-checked reimport instead of first-import no-op', async () => {
  state.markers.set('codex', { importedAt: 'fixture', files: {}, groups: ['settings'] });
  state.diff.mockResolvedValue({ entries: [{ id: 'config', path: 'config', group: 'settings', state: 'userChanged', revision: 'snapshot-revision' }], issues: [] });
  state.reimport.mockResolvedValue({ issues: [], imported: 1 });
  const api = await import('./agent-homes');
  expect(await api.answerAgentHomeCall({ action: 'import', providerId: 'codex', groups: ['settings'] })).toMatchObject({ result: { providerId: 'codex', imported: 1, hasMarker: true } });
  expect(state.reimport).toHaveBeenCalledWith(expect.objectContaining({ providerId: 'codex' }), new Set(['config']), new Map([['config', 'snapshot-revision']]));
  expect(state.importHome).not.toHaveBeenCalled();
});
