import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { RecordLineageNode, SessionRecordLocator, SessionTimeline } from './contract';
import type { TimelineArchive } from './timeline';
import { createSessionRecordSource } from './index';
import { SessionRecordNotFoundError } from './sources/shared';
import { rebindZstResume, zstResumeUnchanged } from './sources/jsonl-tail-source';
import { createSessionTimeline } from './timeline';

/**
 * Ingestion reads a native record so its turns can be copied into the store, without ever holding the record (resume-mem).
 *
 * Settled turns are handed to `onSettled` as the record streams and forgotten; only the last committed turn and the active
 * one stay on the reducer, because only those can still change. The returned checkpoint is the timeline's own archive at
 * that state: the next ingest restores it and reads only what the record grew by.
 *
 * Runs in the ingest child process. It reads files only through the record sources (`createSessionTimeline`).
 */
export type IngestRead = {
  /** `unchanged`: a `.zst` archive that has not moved since the checkpoint; nothing was read. */
  status: 'complete' | 'unchanged';
  /** The turns still held at the end: the last committed one (re-read every time) and the active one, if any. */
  tail: TranscriptTurn[];
  /** How many of `tail` are committed; a turn after them is the active one. */
  committed: number;
  /** Global index of `tail[0]` in the record. */
  tailFrom: number;
  /** The checkpoint was used: only what the record grew by was read. `false` = read from the start. */
  resumed: boolean;
  checkpoint: TimelineArchive | null;
  prunedDrops: number;
  lineage: readonly RecordLineageNode[] | null;
};

export async function readRecordForIngest(input: {
  locator: SessionRecordLocator;
  sessionId: string;
  checkpoint: TimelineArchive | null;
  parentLineage?: readonly RecordLineageNode[];
  /** Read as a snapshot (a fork proves its parent's prefix only there); no resume point is kept for a plain file. */
  snapshot?: boolean;
  /** Settled turns in record order, with the global index of the first one. Synchronous: it runs inside the read. */
  onSettled: (turns: TranscriptTurn[], from: number) => void;
}): Promise<IngestRead> {
  let checkpoint = input.checkpoint;
  if (checkpoint && await zstResumeUnchanged(checkpoint.resume)) {
    return { status: 'unchanged', tail: [], committed: 0, tailFrom: checkpoint.retainedFrom ?? 0, resumed: true, checkpoint, prunedDrops: 0, lineage: null };
  }
  if (checkpoint) {
    const resume = await rebindZstResume(checkpoint.resume);
    checkpoint = resume ? { ...checkpoint, resume } : null;
  }
  // The live mode reads only the plain `.jsonl` and can resume; a record that exists only as `.zst` is read as a snapshot.
  if (input.snapshot) return await read(input, 'snapshot', null);
  try {
    return await read(input, 'live', checkpoint);
  } catch (error) {
    if (!(error instanceof SessionRecordNotFoundError)) throw error;
    return await read(input, 'snapshot', null);
  }
}

async function read(
  input: Parameters<typeof readRecordForIngest>[0],
  readMode: 'live' | 'snapshot',
  archive: TimelineArchive | null,
): Promise<IngestRead> {
  let next = archive?.retainedFrom ?? 0;
  let resets = 0;
  const drain = (timeline: SessionTimeline) => {
    const drained = timeline.drainSettled!();
    if (drained.resets !== resets) {
      // The source refused the resume point (or the file was replaced) and reads from the start. Before anything was
      // handed out that is a full read; after, the turns already handed out belong to a record that no longer exists.
      if (next !== (archive?.retainedFrom ?? 0) || drained.resets > 1) throw new Error('Record replaced while it was being ingested');
      resets = drained.resets;
      next = 0;
    }
    if (!drained.turns.length) return;
    input.onSettled(drained.turns, next);
    next += drained.turns.length;
  };
  const source = createSessionRecordSource(input.locator, {
    ...(readMode === 'snapshot' ? { readMode } : {}),
    drained: true,
    ...(input.parentLineage ? { parentLineage: input.parentLineage } : {}),
  });
  const timeline = await createSessionTimeline(source, { sessionId: input.sessionId, archive, onApplied: drain });
  try {
    drain(timeline);
    const tail = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
    const committed = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER, committedOnly: true }).turns.length;
    const checkpoint = await timeline.archive?.({ maxSourceBytes: Number.MAX_SAFE_INTEGER }) ?? null;
    return {
      status: 'complete',
      tail,
      committed,
      tailFrom: next,
      resumed: !!archive && resets === 0,
      checkpoint,
      prunedDrops: timeline.drainSettled!().prunedDrops,
      lineage: timeline.getRecordLineage?.() ?? null,
    };
  } finally {
    timeline.dispose();
  }
}
