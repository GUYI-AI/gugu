import { statSync } from 'node:fs';
import { appendFile, mkdir, open, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { app } from 'electron';
import { markHistoryReverted, type TranscriptTurn } from '@gugu/session-core/acp';
import type { JournalLine, SessionRecordLocator } from '@gugu/session-core/session-record';
import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import { sessionRecordHarnessForProvider } from '../session-timeline/locate';

/**
 * Gugu's journal of each session (`@gugu/session-core` `sources/gugu-journal.ts` reads it): what no agent record
 * holds, one whole turn per line. The turns of a harness gugu has no record reader for, the turns gugu adds to
 * any session (an agent's notification to its owner), and a recorded turn's end that only the runtime saw (`recorded`).
 * A line is `{ id, at, turn }`; a later line with the same id is that turn again, changed (a late tail, a revision),
 * and takes its place.
 *
 * Writes for one session go one after another; a revert rewrites the file whole (temp file, then rename), which the
 * reader sees as a replaced file and reads again.
 */
const DIRECTORY = 'session-journal';

function root(): string {
  return join(app.getPath('userData'), DIRECTORY);
}

function fileOf(sessionId: string): string {
  // A session id goes into a file name.
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sessionId)) throw new Error(`not a session id: ${sessionId}`);
  return join(root(), `${sessionId}.jsonl`);
}

export function journalLocator(sessionId: string): SessionRecordLocator {
  return { harness: 'gugu', providerSessionId: sessionId, roots: [root()] };
}

/** The line id of a turn: the runtime's turn id and when it started (runtime ids restart with the runtime). */
export function journalLineId(turn: Pick<TranscriptTurn, 'id' | 'startedAt'>): string {
  return `${turn.id}@${turn.startedAt ?? 0}`;
}

const tails = new Map<string, Promise<unknown>>();
function queued<T>(sessionId: string, task: () => Promise<T>): Promise<T> {
  const next = (tails.get(sessionId) ?? Promise.resolve()).then(task, task);
  const tail = next.then(() => undefined, () => undefined);
  tails.set(sessionId, tail);
  void tail.then(() => { if (tails.get(sessionId) === tail) tails.delete(sessionId); });
  return next;
}

/** The journal exists (empty if nothing was written yet), so a reader can tail it from the start. */
export async function ensureJournal(sessionId: string): Promise<void> {
  await mkdir(root(), { recursive: true });
  await (await open(fileOf(sessionId), 'a')).close();
}

export function journalHasTurns(sessionId: string): boolean {
  try { return statSync(fileOf(sessionId)).size > 0; } catch { return false; }
}

export function appendJournalTurn(sessionId: string, turn: TranscriptTurn, recorded = false): Promise<void> {
  const line: JournalLine = { id: journalLineId(turn), at: turn.startedAt ?? Date.now(), turn, ...(recorded ? { recorded: true as const } : {}) };
  return queued(sessionId, async () => {
    await mkdir(root(), { recursive: true });
    await appendFile(fileOf(sessionId), `${JSON.stringify(line)}\n`, 'utf8');
  });
}

async function readLines(sessionId: string): Promise<Map<string, JournalLine>> {
  let text: string;
  try { text = await readFile(fileOf(sessionId), 'utf8'); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw error;
  }
  const lines = new Map<string, JournalLine>();
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    const line = JSON.parse(raw) as JournalLine;
    lines.set(line.id, line);
  }
  return lines;
}

async function rewrite(sessionId: string, lines: Iterable<JournalLine>): Promise<void> {
  const file = fileOf(sessionId);
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, [...lines].map((line) => `${JSON.stringify(line)}\n`).join(''), 'utf8');
  await rename(tmp, file);
}

/** The journal's turns, in order (the last line of each id). */
export async function journalTurns(sessionId: string): Promise<TranscriptTurn[]> {
  return [...(await readLines(sessionId)).values()].map((line) => line.turn);
}

/**
 * Where a resumed runtime numbers its turns from: past every runtime turn the journal names, its own turns and the
 * turns its owner notifications came from. A notification joins its turn by that id, so a new turn must not take it.
 */
export async function journalTurnIndexBase(sessionId: string): Promise<number> {
  let max = -1;
  for (const line of (await readLines(sessionId)).values()) {
    const sources = [line.turn.id, ...line.turn.items.flatMap((item) => item.kind === 'message' && item.ownerNotification?.sourceTurnId ? [item.ownerNotification.sourceTurnId] : [])];
    for (const id of sources) {
      const index = /:turn:(\d+)$/.exec(id)?.[1];
      if (index !== undefined) max = Math.max(max, Number(index));
    }
  }
  return max + 1;
}

/**
 * A revert to the person's message `anchor`: that turn and every turn after it leave the journal, and the last turn
 * kept says how many went. No such message here (the session's turns are in its agent's record) changes nothing.
 */
export function revertJournal(sessionId: string, anchor: string): Promise<void> {
  return queued(sessionId, async () => {
    const lines = [...(await readLines(sessionId)).values()];
    const from = lines.findIndex((line) => line.turn.items.some((item) => item.kind === 'message' && item.role === 'user' && item.revertAnchor === anchor));
    if (from < 0) return;
    const kept = lines.slice(0, from);
    const removed = lines.slice(from).filter((line) => !line.recorded && line.turn.items.some((item) => item.kind === 'message' && item.role === 'user')).length;
    const last = kept.findLastIndex((line) => !line.recorded && !line.turn.items.some((item) => item.kind === 'message' && item.ownerNotification));
    if (last >= 0 && removed > 0) kept[last] = { ...kept[last]!, turn: markHistoryReverted(kept[last]!.turn, removed, Date.now()) };
    await rewrite(sessionId, kept);
  });
}

/**
 * Lines that only the old turn table holds, merged in: each goes in by its id once, in time order with what is
 * there. Running it again adds nothing.
 */
export function mergeIntoJournal(sessionId: string, incoming: readonly JournalLine[]): Promise<number> {
  return queued(sessionId, async () => {
    const lines = await readLines(sessionId);
    const fresh = incoming.filter((line) => !lines.has(line.id));
    if (fresh.length === 0) return 0;
    const merged = [...lines.values(), ...fresh].sort((a, b) => a.at - b.at);
    await mkdir(root(), { recursive: true });
    await rewrite(sessionId, merged);
    return fresh.length;
  });
}

/**
 * A turn the runtime committed, kept here when its agent keeps no record gugu reads. With a record, the record has
 * the turn, but not a failure only the runtime saw (the engine died mid-turn, a prompt never delivered; a revision
 * when the exit comes after): that turn is kept as `recorded`, for its outcome. A replay is history the runtime read
 * back, already here.
 */
export function journalCommittedTurn(event: { sessionId: string; providerId?: string; source: string; turn: TranscriptTurn }): void {
  if (event.source === 'replay') return;
  const provider = event.providerId ?? db.select({ provider: sessions.provider }).from(sessions).where(eq(sessions.id, event.sessionId)).get()?.provider;
  const recorded = sessionRecordHarnessForProvider(provider) !== null;
  if (recorded && event.turn.outcome?.kind !== 'error') return;
  void appendJournalTurn(event.sessionId, event.turn, recorded).catch((error: unknown) => {
    log.warn('sessionJournal: a committed turn was not written', { sessionId: event.sessionId, error: String(error) });
  });
}
