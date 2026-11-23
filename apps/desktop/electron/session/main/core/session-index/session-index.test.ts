import { EventEmitter } from 'node:events';
import type { SessionTimeline } from '@gugu/session-core/session-record';
import { expect, it, vi } from 'vitest';
import type { IndexCommand } from './worker';

type Request = { id: number; command: IndexCommand };
const mocks = vi.hoisted(() => ({ workers: [] as Array<EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(request: Request) => void>>;
  terminate: ReturnType<typeof vi.fn>;
}> }));

vi.mock('node:worker_threads', () => ({ Worker: class extends EventEmitter {
  unref = vi.fn();
  postMessage = vi.fn<(request: Request) => void>();
  terminate = vi.fn(async () => 1);
  constructor() { super(); mocks.workers.push(this); }
} }));
vi.mock('@main/worker-manifest', () => ({ desktopWorkerPath: () => '/build/session-index.js' }));
vi.mock('@main/db/path', () => ({ resolveDatabasePath: () => '/isolated/history.db' }));
vi.mock('@main/db/client', () => ({ sqlite: undefined }));

const { followSessionIndex, stopSessionIndex } = await import('./session-index');

it('flushes a timeline with pending changes before terminating the index worker', async () => {
  const cursor = { epoch: 'first', seq: 0 };
  const unsubscribe = vi.fn();
  const subscribe: SessionTimeline['subscribe'] = (_, listener) => {
    listener({ ok: true, batch: { from: 0, cursor, turns: [], removedTurnIds: ['previous'], settlements: [] } });
    return unsubscribe;
  };
  const unfollow = followSessionIndex('s', { getCursor: () => cursor, subscribe } as SessionTimeline, () => ({ locator: null, journal: null }));

  const shutdown = stopSessionIndex();
  const worker = mocks.workers[0]!;
  const requests = worker.postMessage.mock.calls.map(([request]) => request);
  expect(requests.map(({ command }) => command.kind)).toEqual(['read', 'update', 'ready']);
  expect(requests[1]?.command).toMatchObject({ kind: 'update', removed: ['previous'] });
  expect(worker.terminate).not.toHaveBeenCalled();
  worker.emit('message', { id: requests[0]!.id, result: 'indexed' });
  worker.emit('message', { id: requests[1]!.id, result: 'indexed' });
  worker.emit('message', { id: requests[2]!.id, result: 'ready' });
  await shutdown;

  unfollow();
  expect(unsubscribe).toHaveBeenCalledOnce();
  expect(worker.terminate).toHaveBeenCalledOnce();
});
