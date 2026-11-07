import { setImmediate } from 'node:timers/promises';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import { advanceReverseIndexTask } from './record-locators';
import type { ReverseCheckpoint, SourceRange, WindowIoCounters } from './types';

type Job = { path: string; checkpoint: ReverseCheckpoint; directory: string; scope: string };

/** One selected job plus one replaceable pending job; no history-sized in-memory queue. */
export function createReverseIndexScheduler(callbacks: {
  onFailure(error: unknown): void;
  onStep?(checkpoint: ReverseCheckpoint, io: Readonly<WindowIoCounters>): void;
  onLocated?(ticket: string, range: SourceRange): void;
}) {
  let queued: Job | null = null, current: Job | null = null, controller: AbortController | null = null;
  let runner: Promise<void> | null = null, disposed = false;
  async function locate(job: Job, signal: AbortSignal): Promise<void> {
    const source = await openWindowByteSource(job.path);
    try {
      let checkpoint = job.checkpoint;
      for (;;) {
        await setImmediate(undefined, { signal }); // Give foreground requests a scheduling point before every read.
        const budget = createWindowBudget();
        const result = await advanceReverseIndexTask(job.directory,
          { scope: job.scope, sourceLineage: checkpoint.sourceLineage, decoderVersion: 1, jobId: checkpoint.jobId },
          source, checkpoint, budget, signal);
        if (result.kind === 'reset') throw new Error('Reverse locating source changed');
        checkpoint = result.checkpoint;
        callbacks.onStep?.(checkpoint, budget.counters);
        if (result.kind === 'located') { callbacks.onLocated?.(checkpoint.jobId, result.range); return; }
      }
    } finally { await source.close(); }
  }
  async function drain(): Promise<void> {
    while (queued && !disposed) {
      current = queued; queued = null;
      controller = new AbortController();
      try { await locate(current, controller.signal); }
      catch (error) { if (!controller.signal.aborted) callbacks.onFailure(error); }
      finally { controller = null; current = null; }
    }
  }
  return {
    schedule(path: string, checkpoint: ReverseCheckpoint, directory: string, scope: string): void {
      if (disposed) throw new Error('Reverse locating scheduler is disposed');
      if (current?.checkpoint.jobId === checkpoint.jobId || queued?.checkpoint.jobId === checkpoint.jobId) return;
      queued = { path, checkpoint, directory, scope };
      controller?.abort();
      if (!runner) runner = drain().finally(() => { runner = null; });
    },
    /** Foreground may pause immediately; a future selection resumes from the persisted checkpoint. */
    async pause(): Promise<void> { queued = null; controller?.abort(); await runner; },
    async dispose(): Promise<void> { disposed = true; queued = null; controller?.abort(); await runner; },
  };
}
