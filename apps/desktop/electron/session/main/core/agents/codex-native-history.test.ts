import { beforeEach, expect, it, vi } from 'vitest';
import type { ResolvedAgentHome } from '@gugu/session-core/agents/plugins';

const mocks = vi.hoisted(() => ({ marker: vi.fn(), ledger: vi.fn(), relocate: vi.fn(), errors: vi.fn(), version: vi.fn(), rows: [{ id: 'owned' }] }));
vi.mock('@gugu/session-core/agents/plugins/helpers', () => ({ readAgentHomeMarker: mocks.marker }));
vi.mock('@gugu/session-plugins/agents/codex-history', () => ({
  readNativeHistoryLedger: mocks.ledger, relocateNativeCodexHistory: mocks.relocate,
  nativeHistoryCounts: (ledger: { counts: unknown }) => ledger.counts,
}));
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ all: () => mocks.rows }) }) }) } }));
vi.mock('@main/db/schema', () => ({ sessions: { provider: 'provider', providerSessionId: 'providerSessionId' } }));
vi.mock('drizzle-orm', () => ({ eq: vi.fn() }));
vi.mock('@main/core/dependencies/dependency-managers', () => ({ ensureAgentDependenciesProbed: vi.fn(), localDependencyManager: {} }));
vi.mock('@main/core/acp/transport/local-acp-process-host', () => ({ resolveLocalAgentCli: async () => '/selected/codex' }));
vi.mock('./agent-run-context', () => ({ resolveLocalAgentSpawnEnv: async () => ({ CODEX_HOME: '/native', PATH: '/selected' }) }));
vi.mock('@gugu/core/local/childProcess', () => ({ execFile: Object.assign(vi.fn(), { [Symbol.for('nodejs.util.promisify.custom')]: mocks.version }) }));
vi.mock('@main/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn() } }));
vi.mock('../../../../error-summary-reporting-host', () => ({ reportAgentHomeMigrationFailure: mocks.errors }));
const home = { providerId: 'codex', configRoot: '/managed', userConfigRoot: '/native' } as ResolvedAgentHome;
const counts = { removed: 1, pending: 0, retained: 0, unowned: 1 };
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); mocks.marker.mockResolvedValue({}); mocks.ledger.mockResolvedValue(null);
  mocks.version.mockResolvedValue({ stdout: 'codex-cli 0.167.2' }); mocks.relocate.mockResolvedValue({ counts });
});
it('reruns a startup attempt if import publishes its marker while the first check is pending', async () => {
  const first = Promise.withResolvers<null>(); mocks.marker.mockReturnValueOnce(first.promise);
  const api = await import('./codex-native-history'), signal = new AbortController().signal;
  api.startNativeCodexHistoryRelocation(home, signal); api.startNativeCodexHistoryRelocation(home, signal);
  expect(api.nativeCodexHistoryPreparation(home)).toMatchObject({ phase: 'history' });
  first.resolve(null);
  await vi.waitFor(() => expect(mocks.relocate).toHaveBeenCalledOnce());
  await vi.waitFor(() => expect(api.nativeCodexHistoryPreparation(home)).toBeUndefined());
  expect(mocks.relocate.mock.calls[0][0]).toMatchObject({ cliVersion: 'codex-cli 0.167.2', context: { cli: '/selected/codex' }, ownedIds: new Set(['owned']) });
  expect(mocks.version.mock.calls[0][2].env.CODEX_HOME).toBe('/managed');
});
it('does not launch a CLI when relocation is complete and returns actual stored counts', async () => {
  mocks.ledger.mockResolvedValue({ complete: true, counts });
  const api = await import('./codex-native-history'); api.startNativeCodexHistoryRelocation(home, new AbortController().signal);
  await vi.waitFor(() => expect(api.nativeCodexHistoryPreparation(home)).toBeUndefined());
  expect(mocks.version).not.toHaveBeenCalled(); expect(mocks.relocate).not.toHaveBeenCalled();
  expect(await api.nativeCodexHistoryCounts(home)).toEqual(counts);
});
