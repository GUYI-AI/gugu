import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ workers: [] as any[] }));
vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  unref = vi.fn(); postMessage = vi.fn(); terminate = vi.fn(async () => { this.emit('exit', 1); return 1; });
  constructor(readonly file: string, readonly options: unknown) { super(); mocks.workers.push(this); }
} }));
vi.mock('@main/worker-manifest', () => ({ desktopWorkerPath: (id: string) => `/build/${id}.js` }));
vi.mock('@main/db/path', () => ({ resolveDatabasePath: () => '/isolated/history.db' }));

const { searchTaskTurnMatches, stopTaskTurnSearch } = await import('./task-turn-search');
afterEach(() => { stopTaskTurnSearch(); mocks.workers.length = 0; });
const match = (excerpt: string) => ({ sessionId: 's1', projectId: 'p1', agentDisplayName: 'Task one', archived: false, itemId: 'a', role: 'user' as const, excerpt, activity: null, at: '2026-01-01 00:00:00' });

describe('task-turn search thread boundary', () => {
  it('asks one thread, started by the first search on the session database, and gives each search its own answer', async () => {
    const first = searchTaskTurnMatches('li', 100), second = searchTaskTurnMatches('lin');
    expect(mocks.workers).toHaveLength(1);
    const worker = mocks.workers[0]!;
    expect(worker.file).toBe('/build/task-turn-search.js');
    expect(worker.options).toMatchObject({ workerData: { database: '/isolated/history.db' } });
    expect(worker.postMessage.mock.calls.map(([asked]: [{ query: string; limit?: number }]) => [asked.query, asked.limit])).toEqual([['li', 100], ['lin', undefined]]);
    const [li, lin] = worker.postMessage.mock.calls.map(([asked]: [{ id: number }]) => asked.id);
    worker.emit('message', { id: lin, matches: [match('linear')] });
    worker.emit('message', { id: li, matches: [match('list'), match('linear')] });
    expect((await first).map((hit) => hit.excerpt)).toEqual(['list', 'linear']);
    expect((await second).map((hit) => hit.excerpt)).toEqual(['linear']);
  });

  it('fails the search whose query failed, and no other', async () => {
    const bad = searchTaskTurnMatches('"'), good = searchTaskTurnMatches('fine');
    const [badId, goodId] = mocks.workers[0]!.postMessage.mock.calls.map(([asked]: [{ id: number }]) => asked.id);
    mocks.workers[0]!.emit('message', { id: badId, error: 'SqliteError: fts5: syntax error' });
    mocks.workers[0]!.emit('message', { id: goodId, matches: [] });
    await expect(bad).rejects.toThrow('fts5: syntax error');
    await expect(good).resolves.toEqual([]);
  });

  it('fails everything asked of a thread that died, and starts another for the next search', async () => {
    const lost = searchTaskTurnMatches('li');
    mocks.workers[0]!.emit('exit', 1);
    await expect(lost).rejects.toThrow('Task search thread exited (1)');
    void searchTaskTurnMatches('li').catch(() => {});
    expect(mocks.workers).toHaveLength(2);
  });
});
