import { Worker } from 'node:worker_threads';
import type { TimelineArchive } from '@gugu/session-core/session-record';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { desktopWorkerPath } from '../../worker-manifest';
import type { FoldAck, FoldReply, FoldRequest } from './fold';

type Pending = {
  resolve(archive: TimelineArchive | null): void;
  reject(error: Error): void;
  head?: TimelineArchive;
  expected?: number;
  turns: TranscriptTurn[];
};

export type FoldClient = {
  /** The record folded off the main thread (`fold.ts`), ready for `createSessionTimeline({ archive })`; null when it has no resume point. */
  fold(request: FoldRequest): Promise<TimelineArchive | null>;
  dispose(): Promise<void>;
};

/** One fold thread, started on first use; opens running at once share it, their reads interleaving in slices. */
export function createFoldClient(
  warn: (message: string, detail: Record<string, unknown>) => void,
  spawn = () => new Worker(desktopWorkerPath('session-timeline-fold'), { name: 'session-timeline-fold' }),
): FoldClient {
  let worker: Worker | null = null;
  let nextId = 0;
  const pending = new Map<number, Pending>();
  const fail = (error: Error) => {
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const finish = (id: number, request: Pending) => {
    pending.delete(id);
    const head = request.head!;
    request.resolve({ ...head, parser: { ...head.parser, transcript: { ...head.parser.transcript, committed: request.turns } } });
  };
  function start(): Worker {
    const own = spawn();
    own.on('message', (reply: FoldReply) => {
      if ('warning' in reply) { warn('sessionTimeline: fold thread', { warning: reply.warning }); return; }
      const request = pending.get(reply.id);
      if (!request) return;
      if ('error' in reply) {
        pending.delete(reply.id);
        request.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }));
      } else if ('archive' in reply) {
        pending.delete(reply.id);
        request.resolve(null);
      } else {
        if ('head' in reply) {
          request.head = reply.head;
          request.expected = reply.turns;
        } else {
          for (const turn of reply.turns) request.turns.push(turn);
        }
        if (request.turns.length === request.expected) { finish(reply.id, request); return; }
        // After this turn of the event loop, so whatever waits on the main thread runs between two slices.
        setImmediate(() => own.postMessage({ id: reply.id, ack: true } satisfies FoldAck));
      }
    });
    own.on('error', (error) => {
      if (worker !== own) return;
      worker = null;
      fail(error);
      void own.terminate();
    });
    own.on('exit', (code) => {
      if (worker !== own) return;
      worker = null;
      fail(new Error(`Session timeline fold thread exited (${code})`));
    });
    own.unref();
    return own;
  }
  return {
    fold(request) {
      const own = worker ??= start();
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject, turns: [] });
        try { own.postMessage({ id, request }); } catch (error) { pending.delete(id); reject(error as Error); }
      });
    },
    async dispose() {
      const own = worker;
      worker = null;
      fail(new Error('Session timeline fold is shutting down'));
      if (own) await own.terminate();
    },
  };
}
