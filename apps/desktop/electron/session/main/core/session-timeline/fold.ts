import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import {
  createSessionRecordSource,
  createSessionTimeline,
  type RecordLineageNode,
  type SessionRecordLocator,
  type TimelineArchive,
} from '@gugu/session-core/session-record';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';

export type FoldRequest = {
  locator: SessionRecordLocator;
  parentLineage?: readonly RecordLineageNode[];
  sessionId: string;
  answerableQuestions?: boolean;
  /** The checkpoint file: read before the fold, written after it. */
  checkpoint: string;
};

/** Committed turns per message from the fold thread: at a long record's turn sizes about 12 ms to deserialize. */
export const TURNS_PER_MESSAGE = 64;

/**
 * The fold thread's replies: an archive goes over as its `head` (no committed turns), then its turns in slices, each
 * after the main thread took the one before (`FoldAck`). A port hands every message already queued over in one go, so
 * slices sent ahead would be deserialized as one long block.
 */
export type FoldReply =
  | { id: number; archive: null }
  | { id: number; head: TimelineArchive; turns: number }
  | { id: number; turns: TranscriptTurn[] }
  | { id: number; error: { name: string; message: string } }
  | { id: number; warning: string };
/** The main thread took a slice and let its event loop run: the next one may come. */
export type FoldAck = { id: number; ack: true };

/**
 * @@@fold-off-main - folding a long record is seconds of reducer work (a 277 MB Claude record: 5 s), and on the
 * main thread every viewer, tunnel and inbox waits behind it. So the fold runs on a worker thread: it starts from the
 * last checkpoint, reads only what the record grew since, and hands back the archive, which the main thread restores
 * in tens of milliseconds (`createSessionTimeline` with `archive`; 45 ms for that record). Nothing here runs on the main
 * thread, so the archive is not bounded by its budget (`TIMELINE_ARCHIVE_MAX_SOURCE_BYTES`). `write` stores the archive
 * as the next checkpoint; it is separate so the caller can hand the archive over first.
 */
export async function foldRecord(request: FoldRequest): Promise<{ archive: TimelineArchive | null; write(): Promise<void> }> {
  const checkpoint = await readCheckpoint(request.checkpoint);
  const timeline = await createSessionTimeline(createSessionRecordSource(request.locator, { parentLineage: request.parentLineage }), {
    sessionId: request.sessionId,
    archive: checkpoint,
    ...(request.answerableQuestions ? { answerableQuestions: true } : {}),
  });
  let archive: TimelineArchive | null;
  try {
    archive = await timeline.archive?.(Number.MAX_SAFE_INTEGER) ?? null;
  } finally {
    timeline.dispose();
  }
  const write = async () => {
    // Nothing new was read: the checkpoint on disk already says the same.
    if (!archive || archive.sourceBytes === checkpoint?.sourceBytes) return;
    await mkdir(dirname(request.checkpoint), { recursive: true });
    // Beside the target, so the rename is atomic; `.fold` keeps it apart from the main thread's own save.
    const tmp = `${request.checkpoint}.${process.pid}.fold.tmp`;
    await writeFile(tmp, JSON.stringify(archive), 'utf8');
    await rename(tmp, request.checkpoint);
  };
  return { archive, write };
}

/** The checkpoint, or null when there is none; one that does not parse is removed (the fold then reads the whole record). */
async function readCheckpoint(file: string): Promise<TimelineArchive | null> {
  let raw: string;
  try {
    // One positional read of the size it has now: a checkpoint is written whole by rename, never appended.
    const handle = await open(file, 'r');
    try {
      const { size } = await handle.stat();
      const { bytesRead, buffer } = await handle.read(Buffer.allocUnsafe(size), 0, size, 0);
      if (bytesRead !== size) throw new Error(`checkpoint read ${bytesRead} of ${size} bytes`);
      raw = buffer.toString('utf8');
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  try {
    const parsed = JSON.parse(raw) as TimelineArchive;
    if (parsed && typeof parsed === 'object' && typeof parsed.epoch === 'string') return parsed;
  } catch { /* removed below */ }
  await rm(file, { force: true });
  return null;
}
