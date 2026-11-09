import { setImmediate } from 'node:timers/promises';
import { openWindowByteSource } from './file-source';
import { createWindowBudget } from './read-budget';
import { advanceReverseIndexTask, loadReverseIndexTask } from './record-locators';
import type { ReverseCheckpoint, SourceRange, WindowIoCounters } from './types';

type Job = { path: string; checkpoint: ReverseCheckpoint; directory: string; scope: string };

/** One selected job plus one replaceable pending job; no history-sized in-memory queue. */
export function createReverseIndexScheduler(callbacks: {
  onFailure(error: unknown, jobId: string): void;
  onStep?(checkpoint: ReverseCheckpoint, io: Readonly<WindowIoCounters>): void;
  /** Actual read accounting for every admitted batch, including cancellation or failure. */
  onRead?(jobId: string, io: Readonly<WindowIoCounters>): void;
  onLocated?(ticket: string, range: SourceRange): void;
}) {
  let queued: Job | null = null, current: Job | null = null, controller: AbortController | null = null;
  let runner: Promise<void> | null = null, disposed = false;
  async function locate(job: Job, signal: AbortSignal): Promise<void> {
    const source = await openWindowByteSource(job.path);
    try {
      let checkpoint = job.checkpoint;
      let restoring = true;
      for (;;) {
        await setImmediate(undefined, { signal }); // Give foreground requests a scheduling point before every read.
        const budget = createWindowBudget();
        try {
          if (restoring) {
            const saved = await loadReverseIndexTask(job.directory,
              { scope: job.scope, sourceLineage: checkpoint.sourceLineage, decoderVersion: 1, jobId: checkpoint.jobId }, budget);
            signal.throwIfAborted();
            if (saved.kind === 'hit') {
              const persisted = saved.position.checkpoint, actual = await source.snapshot();
              if (['sourceId', 'sourceInstance', 'sourceLineage', 'snapshotRevision', 'pinnedEnd', 'recordEnd'].some(key =>
                persisted[key as keyof ReverseCheckpoint] !== checkpoint[key as keyof ReverseCheckpoint]) ||
                persisted.sourceFence.start !== checkpoint.sourceFence.start || persisted.sourceFence.end !== checkpoint.sourceFence.end ||
                persisted.sourceFence.digest !== checkpoint.sourceFence.digest ||
                actual.sourceId !== persisted.sourceId || actual.sourceInstance !== persisted.sourceInstance ||
                actual.snapshotRevision !== persisted.snapshotRevision || actual.size !== persisted.pinnedEnd)
                throw new Error('Reverse locating checkpoint source changed');
              checkpoint = persisted;
              signal.throwIfAborted();
              if (saved.position.kind === 'located') {
                callbacks.onStep?.(checkpoint, budget.counters); signal.throwIfAborted();
                callbacks.onLocated?.(checkpoint.jobId, saved.position.range); return;
              }
            }
            restoring = false;
          }
          const result = await advanceReverseIndexTask(job.directory,
            { scope: job.scope, sourceLineage: checkpoint.sourceLineage, decoderVersion: 1, jobId: checkpoint.jobId },
            source, checkpoint, budget, signal);
          if (result.kind === 'reset') throw new Error('Reverse locating source changed');
          checkpoint = result.checkpoint;
          callbacks.onStep?.(checkpoint, budget.counters);
          signal.throwIfAborted();
          if (result.kind === 'located') { callbacks.onLocated?.(checkpoint.jobId, result.range); return; }
        } finally { callbacks.onRead?.(job.checkpoint.jobId, budget.counters); }
      }
    } finally { await source.close(); }
  }
  async function drain(): Promise<void> {
    while (queued && !disposed) {
      const job = queued;
      current = job; queued = null;
      controller = new AbortController();
      try { await locate(job, controller.signal); }
      catch (error) { if (!controller.signal.aborted) callbacks.onFailure(error, job.checkpoint.jobId); }
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
