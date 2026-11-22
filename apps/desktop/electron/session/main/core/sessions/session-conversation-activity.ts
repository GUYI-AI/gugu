import { eq } from 'drizzle-orm';
import type { TranscriptTurn } from '@gugu/session-core/acp';
import { personalConversationPreview } from '@gugu/session-core/session-record/personal-conversation';
import type { PreviewActivity } from '@gugu/session-core/session-record/preview-activity';
import { activityPreviewSources } from '@gugu/session-chat-ui/activity-preview';
export { personalConversationMessages } from '@gugu/session-core/session-record/personal-conversation';
import { db, type AppDb } from '@main/db/client';
import { kv } from '@main/db/schema';

/** `turnId`: the committed turn the preview came from (kept from before turn ids were recorded: absent). */
type Activity = { text: string; at: string; turnId?: string } & PreviewActivity;
type ActivityDb = Pick<AppDb, 'select' | 'insert'>;
const keyFor = (sessionId: string) => `native-conversation-activity:${sessionId}`;

export function nativeConversationActivity(sessionId: string, source: ActivityDb = db): Activity | null {
  const row = source.select({ value: kv.value }).from(kv).where(eq(kv.key, keyFor(sessionId))).get();
  if (!row) return null;
  const value = JSON.parse(row.value) as Activity | null;
  if (value === null) return null;
  if (typeof value.text !== 'string' || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))
    || (value.turnId !== undefined && typeof value.turnId !== 'string')) throw new Error(`Invalid native conversation activity: ${sessionId}`);
  // Cached text from before fold ownership was recorded says nothing of whose reply it is: the next turn writes it again.
  if (value.activityVersion !== 1 || value.activity === undefined) return null;
  return value;
}

/** A transcript supplies its original message time, never the time it was read. */
export function noteNativeConversationActivity(sessionId: string, turn: TranscriptTurn, source: ActivityDb): boolean {
  const preview = personalConversationPreview(turn, activityPreviewSources);
  if (!preview) return false;
  const latest: Activity = { ...preview, at: new Date(preview.at).toISOString(), turnId: turn.id };
  const before = nativeConversationActivity(sessionId, source);
  if (before && (before.at > latest.at || JSON.stringify(before) === JSON.stringify(latest))) return false;
  source.insert(kv).values({ key: keyFor(sessionId), value: JSON.stringify(latest), updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: JSON.stringify(latest), updatedAt: Date.now() } }).run();
  return true;
}

/** A revert removed everything from `from` (epoch ms) on: a preview of a message at or after it goes. */
export function truncateNativeConversationActivity(sessionId: string, from: number, source: ActivityDb): boolean {
  const current = nativeConversationActivity(sessionId, source);
  if (!current || Date.parse(current.at) < from) return false;
  source.insert(kv).values({ key: keyFor(sessionId), value: 'null', updatedAt: Date.now() })
    .onConflictDoUpdate({ target: kv.key, set: { value: 'null', updatedAt: Date.now() } }).run();
  return true;
}
