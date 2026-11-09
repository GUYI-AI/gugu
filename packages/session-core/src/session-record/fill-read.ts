import type { TranscriptTurn } from '../acp/models/turns/turn';
import type { RecordLineageNode, SessionRecordLocator, SessionTimeline, TurnStart } from './contract';
import { createSessionRecordSource } from './index';
import { readRecordPicture } from './sources/record-images';
import { SessionRecordNotFoundError } from './sources/shared';
import { createSessionTimeline } from './timeline';

/**
 * One streaming read of a native record for a store fill (resume-tail): from `position` (where a turn started, a
 * `RecordEntry.position`; 0 = the beginning) to its end. Settled turns go to `onSettled` as the record
 * streams and are forgotten, so the heap holds the open turns and one batch, whatever the record's size.
 *
 * Reads only through the record sources (`createSessionTimeline`); no whole-file read of its own.
 */
export type FillRead = {
  /** The turns still held at the end: the last committed one and the active one, if any. */
  tail: TranscriptTurn[];
  /** How many of `tail` are committed; a turn after them is the active one. */
  committed: number;
  /** Index of `tail[0]` among the turns this read produced. */
  tailFrom: number;
  /** Where each of `tail` starts in the record and the decoder state there (`startingAt` takes both); null = unknown. */
  tailStarts: Array<TurnStart | null>;
  /** Where the read actually started: the source may refuse `position` (a changed continuation chain) and start at 0. */
  from: number;
  prunedDrops: number;
  lineage: readonly RecordLineageNode[] | null;
};

export async function readRecordFrom(input: {
  locator: SessionRecordLocator;
  sessionId: string;
  position: number;
  /** The decoder state at `position` and the index of the turn starting there, as a read from the beginning has them. */
  at?: { state?: unknown; timeline?: unknown; turn: number };
  /** A fork proves its parent's prefix, which only a snapshot read from the start does. */
  parentLineage?: readonly RecordLineageNode[];
  snapshot?: boolean;
  /** A fill's read (`SessionRecordSourceOptions.fill`): pictures left in the record, decoder states on the entries. */
  fill?: boolean;
  /** `starts[i]`: where `turns[i]` starts in the record, as `startingAt` takes it; null where the source does not say. */
  onSettled: (turns: TranscriptTurn[], from: number, starts: Array<TurnStart | null>) => void;
}): Promise<FillRead> {
  if (input.snapshot || input.parentLineage) return read(input, 'snapshot', 0);
  try {
    return await read(input, 'live', input.position);
  } catch (error) {
    // Only a `.zst` archive is missing to the live mode: it is read as a snapshot, from its start.
    if (!(error instanceof SessionRecordNotFoundError)) throw error;
    return read(input, 'snapshot', 0);
  }
}

async function read(input: Parameters<typeof readRecordFrom>[0], readMode: 'live' | 'snapshot', position: number): Promise<FillRead> {
  const source = createSessionRecordSource(input.locator, {
    ...(readMode === 'snapshot' ? { readMode } : {}),
    ...(input.parentLineage ? { parentLineage: input.parentLineage } : {}),
    ...(input.fill ? { fill: true } : {}),
  });
  const resume = position > 0 ? await source.startingAt?.(position, input.at?.state) ?? null : null;
  let next = 0;
  let resets = 0;
  let frozen = false;
  // A read the caller stops mid-stream can surface as a pipeline abort or the EBADF of its closed fd: keep the reason.
  let stopped: { reason: unknown } | null = null;
  const drain = (timeline: SessionTimeline) => {
    try {
      handOut(timeline);
    } catch (reason) {
      stopped ??= { reason };
      throw reason;
    }
  };
  const handOut = (timeline: SessionTimeline) => {
    // After the initial read the live source keeps following the file; what it adds is the next fill's.
    if (frozen) return;
    const drained = timeline.drainSettled!();
    if (drained.resets !== resets) {
      // The source refused the start point and reads from the beginning: fine before anything was handed out.
      if (next !== 0 || drained.resets > 1) throw new Error('Record replaced while it was being read');
      resets = drained.resets;
    }
    if (!drained.turns.length) return;
    input.onSettled(drained.turns, next, drained.starts);
    next += drained.turns.length;
  };
  const timeline = await createSessionTimeline(source, { sessionId: input.sessionId, resume, onApplied: drain,
    ...(resume && input.at ? { turnIndexBase: input.at.turn, carried: input.at.timeline } : {}) })
    .catch((error: unknown) => { throw stopped ? stopped.reason : error; });
  try {
    drain(timeline);
    frozen = true;
    const tail = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER }).turns;
    const committed = timeline.getSnapshot({ limit: Number.MAX_SAFE_INTEGER, committedOnly: true }).turns.length;
    const tailStarts = [...timeline.heldStarts!()];
    if (tailStarts.length !== tail.length) throw new Error(`fill-read: ${tail.length} turns held, ${tailStarts.length} starts`);
    const after = timeline.drainSettled!();
    if (after.resets !== resets) throw new Error('Record replaced while it was being read');
    return {
      tail,
      committed,
      tailFrom: next,
      tailStarts,
      from: resume && resets === 0 ? position : 0,
      prunedDrops: after.prunedDrops,
      lineage: timeline.getRecordLineage?.() ?? null,
    };
  } finally {
    timeline.dispose();
  }
}

/** A filled-in turn's picture, read back from the session's record as it is now (`readRecordPicture`); null = gone. */
export async function readFilledPicture(locator: SessionRecordLocator, place: { start: number; chars: number; head: string; tail: string }): Promise<string | null> {
  const source = createSessionRecordSource(locator, { readMode: 'snapshot' });
  try {
    const path = await source.recordPath?.();
    return path ? await readRecordPicture(path, place) : null;
  } finally {
    source.stop();
  }
}
