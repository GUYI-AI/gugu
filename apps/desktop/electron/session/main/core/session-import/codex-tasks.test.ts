import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  scan: vi.fn(), verify: vi.fn(), append: vi.fn(), plan: vi.fn(), prepare: vi.fn(), bind: vi.fn(),
  ensure: vi.fn(), root: vi.fn(), write: vi.fn(), existing: vi.fn(),
}));
vi.mock('./codex-task-process', () => ({ readCodexTasks: mocks.scan, verifyCodexTaskFiles: mocks.verify }));
vi.mock('./import-local-session', () => ({ bindLocalSession: mocks.bind }));
vi.mock('@gugu/session-plugins/agents', () => ({ pluginRegistry: { get: () => ({ capabilities: { sessionBundle: { configRoot: {} } } }) } }));
vi.mock('@gugu/session-core/agents/plugins/helpers', () => ({
  resolveAgentHome: () => ({ userConfigRoot: '/source', configRoot: '/managed', historySession: (path: string) => ({ id: path.includes('two') ? 'two' : 'one', primary: true }) }),
  ensureAgentHome: mocks.ensure, planAgentHomeHistory: mocks.plan, appendAgentHomeHistory: mocks.append,
}));
vi.mock('@main/core/agents/agent-home', () => ({ resolveAgentHomeRoot: mocks.root }));
vi.mock('@main/core/agents/managed-codex-history', () => ({ prepareManagedCodexHistory: mocks.prepare }));
vi.mock('@main/utils/userEnv', () => ({ loginShellEnv: () => ({}) }));
vi.mock('@main/app/app-scope', () => ({ appScope: { add: vi.fn() } }));
vi.mock('@main/db/kv', () => ({ KV: class { setOrThrow = mocks.write; } }));
vi.mock('@main/db/client', () => ({ db: { select: () => ({ from: () => ({ where: () => ({ limit: mocks.existing }) }) }) } }));
import { importCodexTasks, cancelCodexTaskImport } from './codex-tasks';

const row = { id: 'one', title: 'Task', cwd: '/project', relativePath: 'sessions/one.jsonl', updatedAt: 1, sizeBytes: 100, revision: 'r1',
  files: [{ relativePath: 'sessions/one.jsonl', nativeId: 'one', cwd: '/project', sizeBytes: 100, historyBase: null }] };
beforeEach(() => {
  for (const mock of Object.values(mocks)) mock.mockReset();
  mocks.scan.mockResolvedValue({ status: 'ready', indexed: 1, missing: 0, invalid: 0, rows: [row] });
  mocks.existing.mockResolvedValue([]);
  mocks.plan.mockImplementation(async home => ({ paths: home.userConfigRoot === '/managed' ? [] : [row.relativePath], issues: [] }));
  mocks.bind.mockResolvedValue({ sessionId: 'task', workingDirectory: '/work', alreadyImported: false });
});

it('plans, stages, verifies the native managed path, then binds a resumable chat task', async () => {
  mocks.append.mockImplementation(async (_home, _paths, options) => options.validate('/staged'));
  const result = await importCodexTasks([{ id: 'one', revision: 'r1' }]);
  expect(result.items).toEqual([{ id: 'one', status: 'imported', sessionId: 'task' }]);
  expect(mocks.plan).toHaveBeenCalledWith(expect.objectContaining({ upgradeHistory: ['sessions/one.jsonl'] }), Number.MAX_SAFE_INTEGER,
    { sessionIds: new Set(['one']), includeShared: false });
  expect(mocks.verify.mock.calls.map(args => args[0])).toEqual(['/staged', '/managed']);
  expect(mocks.prepare).toHaveBeenCalledWith(expect.anything(), expect.any(AbortSignal), undefined, [{ id: 'one', path: '/managed/sessions/one.jsonl' }]);
  expect(mocks.bind).toHaveBeenCalledWith(expect.objectContaining({ sessionView: 'general', filePath: '/managed/sessions/one.jsonl' }),
    { providerSessionId: 'one', title: 'Task', cwd: '/project' });
  expect(mocks.prepare.mock.invocationCallOrder[0]).toBeLessThan(mocks.bind.mock.invocationCallOrder[0]);
});

it('does not copy stale/archived selections or tasks already bound in Gugu', async () => {
  mocks.existing.mockResolvedValue([{ sessionId: 'existing' }]);
  const result = await importCodexTasks([{ id: 'one', revision: 'r1' }, { id: 'two', revision: 'r2' }]);
  expect(result.items).toEqual([{ id: 'one', status: 'existing', sessionId: 'existing' }, { id: 'two', status: 'missing' }]);
  expect(mocks.append).not.toHaveBeenCalled();
  expect(mocks.bind).not.toHaveBeenCalled();
  expect((await importCodexTasks([{ id: 'one', revision: 'old' }])).items).toEqual([{ id: 'one', status: 'changed' }]);
});

it('puts archived ancestor segments in the same bundle without binding them as tasks', async () => {
  const inherited = { relativePath: 'archived_sessions/base.jsonl', nativeId: 'parent', cwd: '/project', sizeBytes: 80, historyBase: null };
  const withParent = { ...row, files: [...row.files, inherited] };
  mocks.scan.mockResolvedValue({ status: 'ready', rows: [withParent] });
  mocks.plan.mockResolvedValue({ paths: ['sessions/one.jsonl', 'archived_sessions/base.jsonl'], issues: [] });
  await importCodexTasks([{ id: 'one', revision: 'r1' }]);
  expect(mocks.append.mock.calls[0][1]).toEqual(['sessions/one.jsonl', 'archived_sessions/base.jsonl']);
  expect(mocks.bind).toHaveBeenCalledOnce();
  expect(mocks.bind.mock.calls[0][1].providerSessionId).toBe('one');
});

it('never binds when native preparation or managed metadata validation fails', async () => {
  mocks.prepare.mockRejectedValueOnce(new Error('native read failed'));
  await expect(importCodexTasks([{ id: 'one', revision: 'r1' }])).rejects.toThrow('native read failed');
  expect(mocks.bind).not.toHaveBeenCalled();
  mocks.verify.mockRejectedValueOnce(new Error('wrong metadata'));
  await expect(importCodexTasks([{ id: 'one', revision: 'r1' }])).rejects.toThrow('wrong metadata');
  expect(mocks.bind).not.toHaveBeenCalled();
});

it('cancels preparation and releases the operation for an idempotent retry', async () => {
  mocks.prepare.mockImplementationOnce(async (_home, signal: AbortSignal) => {
    cancelCodexTaskImport(); signal.throwIfAborted();
  });
  await expect(importCodexTasks([{ id: 'one', revision: 'r1' }])).rejects.toThrow();
  expect(mocks.bind).not.toHaveBeenCalled();
  expect((await importCodexTasks([{ id: 'one', revision: 'r1' }])).items[0].status).toBe('imported');
});
