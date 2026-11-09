import { and, eq } from 'drizzle-orm';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { personalConversationPreview } from '@gugu/session-core/session-record/personal-conversation';
import type { PreviewActivity } from '@gugu/session-core/session-record/preview-activity';
import { activityPreviewSources } from '@gugu/session-chat-ui/activity-preview';
export { personalConversationMessages } from '@gugu/session-core/session-record/personal-conversation';
import { db, type AppDb } from '@main/db/client';
import { kv, sessionTurns } from '@main/db/schema';

type Activity = { text: string; at: string; turnSeq: number } & PreviewActivity;
type ActivityDb = Pick<AppDb, 'select' | 'insert'>;
const keyFor = (sessionId: string) => `native-conversation-activity:${sessionId}`;

export function nativeConversationActivity(sessionId: string, source: ActivityDb = db): Activity | null {
  const row = source.select({ value: kv.value }).from(kv).where(eq(kv.key, keyFor(sessionId))).get();
  if (!row) return null;
  const value = JSON.parse(row.value) as Activity | null;
  if (value === null) return null;
  if (typeof value.text !== 'string' || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at)) || !Number.isInteger(value.turnSeq)) throw new Error(`Invalid native conversation activity: ${sessionId}`);
  if (value.activityVersion !== 1 || value.activity === undefined) {
    // Old cached text has no fold ownership. Rebuild only its recorded turn from the journal;
    // a missing journal cannot establish that this is an ordinary owner reply.
    const stored = source.select({ data: sessionTurns.data }).from(sessionTurns)
      .where(and(eq(sessionTurns.sessionId, sessionId), eq(sessionTurns.seq, value.turnSeq))).get();
    const preview = stored ? personalConversationPreview(JSON.parse(stored.data) as TranscriptTurn, activityPreviewSources) : null;
    return preview ? { ...preview, at: new Date(preview.at).toISOString(), turnSeq: value.turnSeq } : null;
  }
  return value;
}

/** A transcript supplies its original message time, never the time it was read. */
export function noteNativeConversationActivity(sessionId: string, turn: TranscriptTurn, source: ActivityDb): boolean {
  const preview = personalConversationPreview(turn, activityPreviewSources);
  if (!preview) return false;
  const latest: Activity = { ...preview, at: new Date(preview.at).toISOString(), turnSeq: turn.seq };
  const before = nativeConversationActivity(sessionId, source);
  if (before && (before.at > latest.at || JSON.stringify(before) === JSON.stringify(latest))) return false;
  source.insert(kv).values({ key: keyFor(sessionId), value: JSON.stringify(latest), updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify(latest), updatedAt: Date.now() } }).run();
  return true;
}

export function truncateNativeConversationActivity(sessionId: string, fromSeq: number, source: ActivityDb, removed: ReadonlySet<number> = new Set()): boolean {
  const current = nativeConversationActivity(sessionId, source);
  if (!current || (current.turnSeq < fromSeq && !removed.has(current.turnSeq))) return false;
  source.insert(kv).values({ key: keyFor(sessionId), value: 'null', updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: 'null', updatedAt: Date.now() } }).run();
  return true;
}
