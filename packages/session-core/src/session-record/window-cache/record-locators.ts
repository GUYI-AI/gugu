import { readWindowFrame, writeWindowFrame } from './disk-frame.ts';
import type { WindowFrameKey } from './frame.ts';
import { stepReverseIndex, type ReverseIndexStep } from './reverse-index-task.ts';
import type { ReverseCheckpoint, WindowBudget, WindowByteSource } from './types';

type SavedPosition = Exclude<ReverseIndexStep, { kind: 'reset' }>;
type JobKey = Pick<WindowFrameKey, 'scope' | 'sourceLineage' | 'decoderVersion'> & { jobId: string };

function keyFor(job: JobKey): WindowFrameKey {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(job.jobId) || !/^[a-f0-9]{64}$/.test(job.scope) ||
    !/^[a-f0-9]{64}$/.test(job.sourceLineage)) throw new Error('Invalid locating job key');
  // A job has one atomic small root, independent of the session's published tail head.
  return { scope: job.scope, sourceLineage: job.sourceLineage, decoderVersion: job.decoderVersion,
    kind: 'head', cursor: `reverse:${job.jobId}` };
}

function checkpointValid(value: ReverseCheckpoint, job: JobKey): boolean {
  return value?.version === 1 && value.jobId === job.jobId && value.sourceLineage === job.sourceLineage &&
    [value.sourceId, value.sourceInstance, value.snapshotRevision].every(v => typeof v === 'string' && v.length > 0 && v.length <= 256) &&
    [value.pinnedEnd, value.recordEnd, value.scanBefore, value.sourceFence?.start, value.sourceFence?.end]
      .every(v => Number.isSafeInteger(v) && v >= 0) &&
    value.scanBefore <= value.recordEnd && value.recordEnd <= value.pinnedEnd &&
    value.sourceFence.start <= value.sourceFence.end && value.sourceFence.end <= value.pinnedEnd &&
    /^[a-f0-9]{64}$/.test(value.sourceFence.digest);
}

/** Fixed-address, checksummed and source-bound progress; no history directory listing. */
export async function loadReverseIndexTask(directory: string, job: JobKey, budget: WindowBudget) {
  const frame = await readWindowFrame(directory, keyFor(job), budget);
  if (frame.kind === 'miss') return frame;
  if (frame.bytes.length > 4096) throw new Error('Oversized reverse-index checkpoint');
  budget.charge('decodedBytes', frame.bytes.length);
  const saved = JSON.parse(Buffer.from(frame.bytes).toString('utf8')) as SavedPosition;
  if (!checkpointValid(saved?.checkpoint, job) || !['scanning', 'located'].includes(saved.kind) ||
    (saved.kind === 'located' && (!Number.isSafeInteger(saved.range?.start) || saved.range.start < 0 ||
      saved.range.start > saved.range.end || saved.range.end !== saved.checkpoint.recordEnd)))
    throw new Error('Invalid reverse-index checkpoint');
  return { kind: 'hit' as const, position: saved };
}

export async function saveReverseIndexTask(directory: string, job: JobKey, position: SavedPosition): Promise<void> {
  const key = keyFor(job);
  const cp = position.checkpoint;
  if (!checkpointValid(cp, job) || (position.kind === 'located' &&
    (!Number.isSafeInteger(position.range.start) || position.range.start < 0 ||
      position.range.start > position.range.end || position.range.end !== cp.recordEnd)))
    throw new Error('Invalid reverse-index checkpoint');
  // Pick bounded scalars before encoding, rather than serialize arbitrary caller state.
  const checkpoint: ReverseCheckpoint = { version: cp.version, jobId: cp.jobId, sourceId: cp.sourceId,
    sourceInstance: cp.sourceInstance, sourceLineage: cp.sourceLineage, snapshotRevision: cp.snapshotRevision,
    pinnedEnd: cp.pinnedEnd, recordEnd: cp.recordEnd, scanBefore: cp.scanBefore,
    sourceFence: { start: cp.sourceFence.start, end: cp.sourceFence.end, digest: cp.sourceFence.digest } };
  const encoded = Buffer.from(JSON.stringify(position.kind === 'located'
    ? { kind: position.kind, checkpoint, range: { start: position.range.start, end: position.range.end } }
    : { kind: position.kind, checkpoint }));
  await writeWindowFrame(directory, key, encoded);
}

/** Exactly one block per invocation. Await durability before scheduling the next step.
 * Foreground work can stop scheduling at every return; a crash repeats at most one block.
 */
export async function advanceReverseIndexTask(directory: string, job: JobKey, source: WindowByteSource,
  checkpoint: ReverseCheckpoint, budget: WindowBudget, signal?: AbortSignal): Promise<ReverseIndexStep> {
  const result = await stepReverseIndex(source, checkpoint, budget, signal);
  signal?.throwIfAborted();
  if (result.kind !== 'reset') await saveReverseIndexTask(directory, job, result);
  signal?.throwIfAborted();
  return result;
}
