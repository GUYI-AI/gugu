import { historyTime } from '@gugu/core/shared/conversationHistoryTime';
import type { TranscriptTurn } from '../acp';

export const historyClearEpoch = (floor: string) => `:history-cleared:${floor}`;

/** A live message's admitted time survives a provider alias or a later revision of its turn. */
export function nativeMessageTime(turn: TranscriptTurn, item: Extract<TranscriptTurn['items'][number], { kind: 'message' }>): bigint | undefined {
  const published = item._meta?.guguPublicationAt;
  if (typeof published === 'string') return historyTime(published);
  const at = item.at ?? (item.role === 'user' ? turn.startedAt : turn.endedAt);
  return at === undefined ? undefined : BigInt(at) * 1_000_000n;
}

/** A clear boundary belongs to the reader. It does not rewrite the model's context or stop its turn. */
export function clearedHistoryTurns<T extends TranscriptTurn>(turns: T[], floor?: string | null): T[] {
  if (!floor) return turns;
  const boundary = historyTime(floor);
  return turns.flatMap(turn => {
    let admitted = false;
    const items = turn.items.filter(item => {
      if (item.kind === 'message') {
        const at = nativeMessageTime(turn, item);
        admitted = at !== undefined && at >= boundary;
      }
      return admitted;
    });
    return items.length ? [{ ...turn, items, ...('itemIds' in turn ? { itemIds: items.map(item => item.id) } : {}) }] : [];
  });
}

/** Apply the same boundary to snapshots, incremental batches, older pages and deferred body references. */
export function clearedHistoryResult<T>(input: T, floor?: string | null): T {
  if (!floor || !input || typeof input !== 'object') return input;
  const value = input as Record<string, unknown>;
  if (value.snapshot) return { ...value, snapshot: clearedHistoryResult(value.snapshot, floor) } as T;
  if (value.batch) return { ...value, batch: clearedHistoryResult(value.batch, floor) } as T;
  if (!Array.isArray(value.turns)) return input;
  const turns = clearedHistoryTurns(value.turns as TranscriptTurn[], floor);
  const ids = new Set(turns.flatMap(turn => turn.items.map(item => item.id)));
  const turnIds = new Set(turns.map(turn => turn.id));
  const aligned = (rows: unknown[]) => rows.filter((_, index) => turnIds.has((value.turns as TranscriptTurn[])[index]?.id));
  const epoch = (value: string) => value.endsWith(historyClearEpoch(floor)) ? value : value + historyClearEpoch(floor);
  return { ...value, turns,
    ...(typeof value.epoch === 'string' ? { epoch: epoch(value.epoch) } : {}),
    ...(value.cursor && typeof value.cursor === 'object' && 'epoch' in value.cursor
      ? { cursor: { ...value.cursor, epoch: epoch(String(value.cursor.epoch)) } } : {}),
    ...(Array.isArray(value.originTurnIds) ? { originTurnIds: aligned(value.originTurnIds) } : {}),
    ...(Array.isArray(value.turnRevisions) ? { turnRevisions: aligned(value.turnRevisions) } : {}),
    ...('bodyRefs' in value ? { bodyRefs: (value.bodyRefs as { itemId?: string }[]).filter(ref => ref.itemId && ids.has(ref.itemId)) } : {}),
    ...('sourceFragments' in value ? { sourceFragments: [] } : {}),
    ...(turns.length < value.turns.length ? { hasOlder: false, moreBefore: 'no', olderCursor: null, nextCursor: null } : {}),
  } as T;
}
