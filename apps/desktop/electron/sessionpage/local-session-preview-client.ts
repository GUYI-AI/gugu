import { Worker } from 'node:worker_threads';
import { desktopWorkerPath } from '../session/main/worker-manifest';
import type { BoundedLocalPreview, LocalPreviewRequest } from './local-session-preview';

type Reply = { id: number; value: BoundedLocalPreview } | { id: number; error: { name: string; message: string } };
type Pending = { resolve(value: BoundedLocalPreview): void; reject(error: Error): void; clean(): void };

/** Only paths/options cross into the thread; only a <=32KiB preview crosses back. */
export function createLocalSessionPreviewClient(spawn = () => new Worker(desktopWorkerPath('local-session-preview'), {
  name: 'local-session-preview', resourceLimits: { maxOldGenerationSizeMb: 64 },
})) {
  let worker: Worker | null = null, disposed = false, nextId = 0;
  const pending = new Map<number, Pending>();
  const stopping = new Set<Promise<void>>();
  let cleanupFailure: unknown;
  function terminate(own: Worker): Promise<void> {
    const stopped = own.terminate().then(() => {}, error => { cleanupFailure = error; }).finally(() => stopping.delete(stopped));
    stopping.add(stopped); return stopped;
  }
  const fail = (error: Error) => {
    for (const request of pending.values()) { request.clean(); request.reject(error); }
    pending.clear();
  };
  function start(): Worker {
    const own = spawn();
    own.on('message', (reply: Reply) => {
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id); request.clean();
      if ('error' in reply) request.reject(Object.assign(new Error(reply.error.message), { name: reply.error.name }));
      else request.resolve(reply.value);
    });
    own.on('error', error => {
      if (worker !== own) return;
      worker = null; fail(error); void terminate(own);
    });
    own.on('exit', code => {
      if (worker !== own) return;
      worker = null; fail(new Error(`Local session preview thread exited (${code})`));
    });
    own.unref();
    return own;
  }
  return {
    read(request: LocalPreviewRequest, signal: AbortSignal): Promise<BoundedLocalPreview> {
      if (disposed) return Promise.reject(new Error('Local session preview is shutting down'));
      signal.throwIfAborted();
      if (pending.size >= 32) return Promise.reject(new Error('Local session preview request limit reached'));
      const own = worker ??= start(), id = ++nextId;
      return new Promise((resolve, reject) => {
        const cancel = () => {
          if (!pending.delete(id)) return;
          own.postMessage({ id, cancel: true });
          clean(); reject(signal.reason instanceof Error ? signal.reason : new Error('Local session preview cancelled'));
        };
        // Includes waiting for earlier bounded requests; a stalled filesystem
        // must not leave the caller and its worker alive indefinitely.
        const timeout = setTimeout(() => {
          if (worker !== own || !pending.has(id)) return;
          worker = null; fail(new Error('Local session preview deadline exceeded'));
          void terminate(own);
        }, 10_000);
        const clean = () => { clearTimeout(timeout); signal.removeEventListener('abort', cancel); };
        pending.set(id, { resolve, reject, clean });
        signal.addEventListener('abort', cancel, { once: true });
        try { own.postMessage({ id, request }); } catch (error) {
          pending.delete(id); clean(); reject(error);
        }
      });
    },
    async dispose(): Promise<void> {
      disposed = true;
      const own = worker; worker = null;
      fail(new Error('Local session preview is shutting down'));
      if (own) await terminate(own);
      await Promise.all(stopping);
      if (cleanupFailure) throw cleanupFailure;
    },
  };
}
