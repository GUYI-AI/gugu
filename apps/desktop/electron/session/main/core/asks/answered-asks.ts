import { eq, like } from 'drizzle-orm';
import type { AnsweredAsk, Settlement } from '@gugu/session-core/session-record/contract';
import { db } from '@main/db/client';
import { kv } from '@main/db/schema';

/**
 * The last Ask a person answered in each session. An answer lets the turn go on, so the status reading keeps no trace of it;
 * the notification list still shows it as handled, the way a failure stays listed while the session rests in error. Both end
 * at the same edge: the session starting its next turn (agent-status-writer). Kept beside the interrupted-turn record.
 */
const PREFIX = 'session-answered-ask:';

export function answeredAskOf(settlement: Settlement): AnsweredAsk {
  return {
    itemId: settlement.itemId,
    ...(settlement.kind ? { kind: settlement.kind } : {}),
    ...(settlement.origin ? { source: settlement.origin.source } : {}),
    optionId: settlement.optionId,
    option: settlement.options?.find(option => option.optionId === settlement.optionId) ?? null,
    resolvedBy: settlement.resolvedBy,
    resolvedAt: settlement.resolvedAt,
  };
}

export function recordAnsweredAsk(sessionId: string, answered: AnsweredAsk, now = Date.now()): void {
  const value = JSON.stringify(answered);
  db.insert(kv)
    .values({ key: `${PREFIX}${sessionId}`, value, updatedAt: now })
    .onConflictDoUpdate({ target: kv.key, set: { value, updatedAt: now } })
    .run();
}

/** True when there was one to clear. */
export function clearAnsweredAsk(sessionId: string): boolean {
  return db.delete(kv).where(eq(kv.key, `${PREFIX}${sessionId}`)).run().changes > 0;
}

/** Every session's record in one read, for the session list. */
export function readAnsweredAsks(): Map<string, AnsweredAsk> {
  const rows = db.select({ key: kv.key, value: kv.value }).from(kv).where(like(kv.key, `${PREFIX}%`)).all();
  return new Map(rows.map(row => [row.key.slice(PREFIX.length), JSON.parse(row.value) as AnsweredAsk]));
}
