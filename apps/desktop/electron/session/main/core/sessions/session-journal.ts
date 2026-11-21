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
 * holds, one whole turn per line. The turns of a harness gugu has no record reader for, and the turns gugu adds to
 * any session (an agent's notification to its owner). A line is `{ id, at, turn }`; a later line with the same id is
 * that turn again, changed (a late tail, a revision), and takes its place.
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

export function appendJournalTurn(sessionId: string, turn: TranscriptTurn, id = journalLineId(turn), at = turn.startedAt ?? Date.now()): Promise<void> {
  const line: JournalLine = { id, at, turn };
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
    const removed = lines.slice(from).filter((line) => line.turn.items.some((item) => item.kind === 'message' && item.role === 'user')).length;
    const last = kept.findLastIndex((line) => !line.turn.items.some((item) => item.kind === 'message' && item.ownerNotification));
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
 * A turn the runtime committed, kept here when its agent keeps no record gugu reads (with a record, the record has
 * it). A replay is history the runtime read back, already here.
 */
export function journalCommittedTurn(event: { sessionId: string; providerId?: string; source: string; turn: TranscriptTurn }): void {
  if (event.source === 'replay') return;
  const provider = event.providerId ?? db.select({ provider: sessions.provider }).from(sessions).where(eq(sessions.id, event.sessionId)).get()?.provider;
  if (sessionRecordHarnessForProvider(provider) !== null) return;
  void appendJournalTurn(event.sessionId, event.turn).catch((error: unknown) => {
    log.warn('sessionJournal: a committed turn was not written', { sessionId: event.sessionId, error: String(error) });
  });
}
