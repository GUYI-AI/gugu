import { nativeConversationUnread } from '../sessions/session-conversation-read';
import type { SessionTimelineResult } from './service';
import type { SessionTimeline } from '@gugu/session-core/session-record/contract';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';
import { ownerNotificationEpoch } from '../sessions/owner-notification-state';

export function createNativeRecordReader(deps: {
  readSession(id: string): { runtime: string | null } | null | undefined;
  activeTurn(id: string): TranscriptTurn | null | undefined;
  withTimeline<T>(id: string, read: (timeline: SessionTimeline) => T | Promise<T>): Promise<SessionTimelineResult<T>>;
  withArchive<T>(id: string, read: () => T | Promise<T>): Promise<SessionTimelineResult<T>>;
}) {
/** ACP phone views share the desktop's committed archive, including provider-generated identities. */
async function nativeRecord(input: { conversationId: string; before?: number; after?: number; tail?: boolean; limit?: number; lean?: boolean | 'folded'; revisionsFrom?: number }): Promise<SessionTimelineResult<import('@gugu/session-core/session-record/contract').NativeSessionRecord>> {
  const row = deps.readSession(input.conversationId);
  if (!row || row.runtime !== 'acp') return { ok: false, error: { code: 'unsupported_runtime', message: '这条会话没有原生对话记录' } };
  return deps.withTimeline(input.conversationId, () => readArchive(input));
}

async function readArchive(input: { conversationId: string; before?: number; after?: number; tail?: boolean; limit?: number; lean?: boolean | 'folded'; revisionsFrom?: number }) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const epoch = ownerNotificationEpoch(input.conversationId);
      const store = await import('../sessions/session-turn-store'), { getStoredHistory } = store;
      const limit = Math.min(100, Math.max(1, input.limit ?? 60));
      const prefix = `${input.conversationId}:turn:s`;
      const first = nativeConversationUnread(input.conversationId)[0];
      const firstSeq = first?.startsWith(prefix) ? Number(/^(\d+):/.exec(first.slice(prefix.length))?.[1]) : NaN;
      const before = input.before ?? (input.after !== undefined ? input.after + limit + 1 : !input.tail && Number.isSafeInteger(firstSeq) ? firstSeq + limit : undefined);
      // Only a read the phone asked for by going back is an older page; opening at the unread line also names a `before`.
      const page = await getStoredHistory({ sessionId: input.conversationId, before, limit, lean: input.lean }, { older: input.before !== undefined });
      const latest = await getStoredHistory({ sessionId: input.conversationId, limit: 1 });
      const selected = page.turns.map((turn, index) => ({ turn, origin: page.originTurnIds[index]!, revision: page.turnRevisions?.[index] }))
        .filter(({ turn }) => input.after === undefined || turn.seq > input.after);
      // A reader that keeps what it read (the phone) names where its turns start; it reads again only those that changed.
      const revisions = input.revisionsFrom === undefined ? undefined : await store.storedTurnRevisions(input.conversationId, input.revisionsFrom);
      const turns = selected.map(one => one.turn);
      const latestStoredSeq = latest.turns.at(-1)?.seq ?? -1;
      const hasNewer = latestStoredSeq > (turns.at(-1)?.seq ?? input.after ?? -1);
      const { trimTurnsForTransport } = await import('@gugu/session-core/session-record');
      const active = deps.activeTurn(input.conversationId);
      if (ownerNotificationEpoch(input.conversationId) !== epoch) continue;
      // Pages carry raw commits. The live turn is independent of how far the archive page has caught up.
      return { ...page, turns, originTurnIds: selected.map(one => one.origin), ...(page.turnRevisions ? { turnRevisions: selected.map(one => one.revision!) } : {}), ...(revisions ? { revisions } : {}),
        latestStoredSeq, hasNewer, nativeOwnerNotificationEpoch: epoch,
        activeTurn: active && !page.originTurnIds.includes(active.id) ? trimTurnsForTransport([active])[0]! : null };
    }
    throw Object.assign(new Error('会话历史正在变化，请稍后重新读取'), { code: 'history_epoch_unstable' });
}

/** A card/list preview owns no timeline, source watcher, cache fill or full-history factory. */
async function preview(input: { conversationId: string; limit?: number }) {
  const row = deps.readSession(input.conversationId);
  if (!row || row.runtime !== 'acp') return { ok: false as const, error: { code: 'unsupported_runtime', message: '这条会话没有原生对话记录' } };
  return deps.withArchive(input.conversationId, () => readArchive({ ...input, tail: true }));
}

async function nativeToolImage(input: { conversationId: string; itemId: string; index: number }): Promise<SessionTimelineResult<import('@gugu/session-core/acp/client').ToolImageLookup>> {
  return deps.withTimeline(input.conversationId, async () => {
    const { findToolImage } = await import('@gugu/session-core/session-record');
    const active = deps.activeTurn(input.conversationId);
    if (active && input.itemId.startsWith(`${active.id}:`)) return findToolImage([active], input.itemId, input.index);
    const prefix = `${input.conversationId}:turn:s`;
    const suffix = input.itemId.startsWith(prefix) ? input.itemId.slice(prefix.length) : '';
    const seq = /^(\d+):/.exec(suffix)?.[1];
    if (seq === undefined) throw new Error('工具图片不属于这条原生会话');
    const { getStoredToolImage } = await import('../sessions/session-turn-store');
    return getStoredToolImage({ sessionId: input.conversationId, seq: Number(seq), itemId: input.itemId, index: input.index });
  });
}

return { snapshot: nativeRecord, preview, image: nativeToolImage };
}
