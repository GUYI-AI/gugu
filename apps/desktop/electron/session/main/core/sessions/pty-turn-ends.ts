import { eq } from 'drizzle-orm';
import { db } from '@main/db/client';
import { kv, sessions } from '@main/db/schema';
import { log } from '@main/lib/logger';
import type { HostTurnEnd, HostTurnEnds } from '@gugu/session-core/session-record/host-turn-end';

const prefix = 'pty-engine-ends:';
type Record = { providerSessionId: string; ends: HostTurnEnd[] };
const watchers = new Map<string, Set<() => void>>();

export function readPtyTurnEnds(sessionId: string, providerSessionId: string): readonly HostTurnEnd[] {
  const value = db.select({ value: kv.value }).from(kv).where(eq(kv.key, prefix + sessionId)).get()?.value;
  if (!value) return [];
  const record = JSON.parse(value) as Record;
  return record.providerSessionId === providerSessionId ? record.ends : [];
}

/** Call only after actual transport death, never on idle hooks, detach, or silence. Persist before publishing idle. */
export function recordPtyEngineEnd(sessionId: string, cutoff: number, observedOnly = false, turnStartedAt?: number): void {
  const row = db.select({ runtime: sessions.runtime, providerSessionId: sessions.providerSessionId })
    .from(sessions).where(eq(sessions.id, sessionId)).get();
  if (!row || row.runtime === 'acp' || !row.providerSessionId) return;
  const ends = readPtyTurnEnds(sessionId, row.providerSessionId);
  // Reopening an already ended turn is not a new death; a later unclosed turn still needs its own observation.
  if (observedOnly && turnStartedAt !== undefined && ends.some(end => end.cutoff >= turnStartedAt)) return;
  if (ends.some(one => one.cutoff === cutoff)) return;
  const record: Record = { providerSessionId: row.providerSessionId,
    ends: [...ends, { cutoff, ...(observedOnly ? {} : { endedAt: cutoff }) }].sort((a, b) => a.cutoff - b.cutoff) };
  db.insert(kv).values({ key: prefix + sessionId, value: JSON.stringify(record), updatedAt: cutoff })
    .onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify(record), updatedAt: cutoff } }).run();
  // A reader failing cannot undo this durable boundary or prevent the host from settling its status.
  for (const changed of [...(watchers.get(sessionId) ?? [])]) {
    try { changed(); }
    catch (error) { log.error('PTY engine end observer failed', { sessionId, error: String(error) }); }
  }
}

export function ptyTurnEnds(sessionId: string, providerSessionId: string): HostTurnEnds {
  return {
    read: () => readPtyTurnEnds(sessionId, providerSessionId),
    subscribe: changed => {
      const listeners = watchers.get(sessionId) ?? new Set();
      listeners.add(changed); watchers.set(sessionId, listeners);
      return () => { listeners.delete(changed); if (!listeners.size) watchers.delete(sessionId); };
    },
  };
}
