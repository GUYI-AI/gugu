import { beforeEach, expect, it, vi } from 'vitest';
import type { ImportProvider } from '@/components/settings/data-import/import-providers';
import { codexEnvironmentProviders, withCodexTaskImport } from '@/components/settings/data-import/environment-import-providers';
import { categoryHistoryReading, groupImportProviders, syncCategoryEnabled } from '@/components/settings/data-import/environment-import-view';

const calls = vi.hoisted(() => ({ scan: vi.fn(), run: vi.fn(), cancel: vi.fn(), scanTasks: vi.fn(), tasks: vi.fn(), cancelTasks: vi.fn(), preparation: vi.fn() }));
vi.mock('@renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionImport: {
  scanEnvironmentImport: calls.scan, importEnvironmentCategory: calls.run, cancelEnvironmentImport: calls.cancel,
  scanCodexTasks: calls.scanTasks, importCodexTasks: calls.tasks, cancelCodexTaskImport: calls.cancelTasks, codexTaskImportProgress: calls.preparation,
} }) }));
beforeEach(() => {
  vi.clearAllMocks();
  calls.cancel.mockResolvedValue(undefined); calls.cancelTasks.mockResolvedValue(undefined);
});
const item = (id: string, status = 'ready') => ({ localSourceId: id, fingerprint: 'revision-' + id, name: id, status });
const progress = () => vi.fn();

it('freezes IDs and fingerprints when queued, even if another scan finishes later', async () => {
  const provider = codexEnvironmentProviders.find(p => p.category === 'skills')!;
  calls.scan.mockResolvedValueOnce({ count: 1, items: [item('first')] });
  await provider.scan(null);
  const queued = provider.capture!();
  calls.scan.mockResolvedValueOnce({ count: 1, items: [item('second')] });
  await provider.scan(null);
  calls.run.mockResolvedValue({ items: [item('first', 'imported')] });
  const result = await queued.importAll(null, progress(), new AbortController().signal);
  expect(calls.run.mock.calls[0]![0].selection).toEqual([{ localSourceId: 'first', fingerprint: 'revision-first' }]);
  expect(result.imported).toEqual([]);
  expect(result.entities).toEqual([{ id: 'first', title: 'first', category: 'skills' }]);
});

it('imports only ready items and retains existing, conflict and invalid counts', async () => {
  const provider = codexEnvironmentProviders.find(p => p.category === 'connectors')!;
  calls.scan.mockResolvedValue({ count: 4, items: [item('ready'), item('exists', 'existing'), item('conflict', 'conflict'), item('invalid', 'skipped')] });
  await provider.scan(null);
  calls.run.mockResolvedValue({ items: [item('ready', 'imported')] });
  const result = await provider.capture!().importAll(null, progress(), new AbortController().signal);
  expect(calls.run.mock.calls[0]![0].selection).toHaveLength(1);
  expect(result).toMatchObject({ existing: 1, failed: 2, imported: [] });
});

it('cancels only the request it started', async () => {
  const provider = codexEnvironmentProviders[0]!;
  calls.scan.mockResolvedValue({ count: 1, items: [item('one')] });
  await provider.scan(null);
  let finish!: (value: { items: unknown[] }) => void;
  calls.run.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  const controller = new AbortController();
  const running = provider.capture!().importAll(null, progress(), controller.signal);
  controller.abort();
  expect(calls.cancel).toHaveBeenCalledWith(calls.run.mock.calls[0]![0].requestId);
  finish({ items: [] }); await running;
});

it('does not start an aborted import or route environment files to a remote host', async () => {
  const provider = codexEnvironmentProviders[0]!;
  const controller = new AbortController(); controller.abort();
  await expect(provider.importAll(null, progress(), controller.signal)).rejects.toThrow();
  expect(await provider.scan('another-machine')).toBeNull();
  expect(calls.run).not.toHaveBeenCalled();
});

it('automatic snapshots exclude previously attempted IDs, including changed revisions', async () => {
  const provider = codexEnvironmentProviders[0]!;
  calls.scan.mockResolvedValue({ count: 2, items: [item('known'), item('new')] });
  await provider.scan(null);
  calls.run.mockResolvedValue({ items: [item('new', 'imported')] });
  await provider.capture!({ known: 'older-revision' }).importAll(null, progress(), new AbortController().signal);
  expect(calls.run.mock.calls[0]![0].selection.map((entry: { localSourceId: string }) => entry.localSourceId)).toEqual(['new']);
});

function transcript(): ImportProvider {
  return { id: 'codex', label: 'Codex', iconId: 'codex', scan: vi.fn().mockResolvedValue({ count: 7, pending: false }),
    importAll: vi.fn().mockResolvedValue({ imported: [], existing: 0, failed: 0 }) };
}
it('uses the existing native task importer locally and preserves remote transcript imports', async () => {
  const previous = transcript(); const provider = withCodexTaskImport(previous);
  calls.scanTasks.mockResolvedValue({ status: 'ready', rows: [{ id: 'native', revision: 'r1', title: 'Resume me' }], blocked: [] });
  calls.tasks.mockResolvedValue({ items: [{ id: 'native', status: 'imported', projectId: 'p', sessionId: 's' }] });
  expect(await provider.scan(null)).toEqual({ count: 1, pending: false });
  const result = await provider.capture!().importAll(null, progress(), new AbortController().signal);
  expect(calls.tasks).toHaveBeenCalledWith([{ id: 'native', revision: 'r1' }]);
  expect(result.imported).toEqual([{ title: 'Resume me', projectId: 'p', sessionId: 's' }]);
  await provider.scan('remote'); await provider.importAll('remote', progress(), new AbortController().signal);
  expect(previous.scan).toHaveBeenCalledWith('remote'); expect(previous.importAll).toHaveBeenCalledOnce();
});

it('an unsupported or unexplained native failure remains a read failure', async () => {
  calls.scanTasks.mockResolvedValue({ status: 'unavailable', rows: [], blocked: [] });
  await expect(withCodexTaskImport(transcript()).scan(null)).rejects.toThrow();
});

it('groups the five native categories once without merging unrelated export-file sources', () => {
  const providers = [withCodexTaskImport(transcript()), ...codexEnvironmentProviders,
    { ...transcript(), id: 'chatgpt-json', label: 'ChatGPT export' }];
  const groups = groupImportProviders(providers);
  expect(groups.map(group => [group.id, group.providers.length])).toEqual([['codex', 5], ['chatgpt-json', 1]]);
});

it('keeps legacy automatic scope limited to tasks and honors an explicitly empty or selected scope', () => {
  expect(syncCategoryEnabled(undefined, 'tasks')).toBe(true);
  expect(syncCategoryEnabled(undefined, 'skills')).toBe(false);
  expect(syncCategoryEnabled([], 'tasks')).toBe(false);
  expect(syncCategoryEnabled(['skills'], 'skills')).toBe(true);
  expect(syncCategoryEnabled(['skills'], 'projects')).toBe(false);
});

it('forwards actual history preparation and stops its poll after completion', async () => {
  vi.useFakeTimers();
  try {
    const provider = withCodexTaskImport(transcript());
    calls.scanTasks.mockResolvedValue({ status: 'ready', rows: [{ id: 'native', revision: 'r1', title: 'Task' }], blocked: [] });
    calls.preparation.mockResolvedValue({ phase: 'history', startedAt: 123 });
    let finish!: (value: { items: unknown[] }) => void;
    calls.tasks.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    await provider.scan(null);
    const report = progress(); const running = provider.capture!().importAll(null, report, new AbortController().signal);
    await vi.advanceTimersByTimeAsync(1000);
    expect(report).toHaveBeenCalledWith(0, 1, { phase: 'history', startedAt: 123 });
    finish({ items: [] }); await running;
    expect(vi.getTimerCount()).toBe(0);
  } finally { vi.useRealTimers(); }
});


const completedHistory = { providerId: 'codex:skills', finishedAt: 2, items: [
  { id: 'skill', title: 'Skill', category: 'skills' as const, status: 'imported' as const },
] }

it.each(['unknown', 'error'] as const)('keeps %s history visibly unread while retaining current completed imports', state => {
  const read = categoryHistoryReading([completedHistory], { state }, 'owner')
  expect(read.state).toBe(state)
  expect(read.items).toEqual([completedHistory])
})

it.each(['unknown', 'error'] as const)('keeps the history placeholder for %s even without current imports', state => {
  const read = categoryHistoryReading([], { state }, 'owner')
  expect(read.state).not.toBe('value')
  expect(read.items).toEqual([])
})

it('only treats a read owner without category results as a confirmed empty history', () => {
  const read = categoryHistoryReading([], { state: 'value', value: { owners: { owner: { automatic: false, sources: [] } } } }, 'owner')
  expect(read).toEqual({ state: 'value', items: [] })
  expect(categoryHistoryReading([], { state: 'value', value: { owners: {} } }, 'owner')).toEqual(read)
})

it('merges history when a background read recovers and prefers current completed results for duplicates', () => {
  const earlier = { ...completedHistory, finishedAt: 1 }
  const read = categoryHistoryReading([completedHistory], { state: 'value', value: { owners: { owner: {
    automatic: false, sources: [], categoryResults: [completedHistory, earlier],
  } } } }, 'owner')
  expect(read.state).toBe('value')
  expect(read.items).toEqual([completedHistory, earlier])
})

it('counts a genuinely absent Codex index as zero without starting an import', async () => {
  calls.scanTasks.mockResolvedValue({ status: 'unavailable', reason: 'missing-index', rows: [], blocked: [] });
  const provider = withCodexTaskImport(transcript());
  expect(await provider.scan(null)).toEqual({ count: 0, pending: false });
  expect(calls.tasks).not.toHaveBeenCalled();
  calls.scanTasks.mockResolvedValue({ status: 'unavailable', reason: 'unsupported-index', rows: [], blocked: [] });
  await expect(provider.scan(null)).rejects.toThrow('unsupported-index');
});
