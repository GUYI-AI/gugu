import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract';
import { projectOwnerNotifications } from '@gugu/session-core/session-record/owner-notifications';
import { turnHeld } from '@gugu/session-core/session-record/held-turn';
import type { TranscriptTurn } from '@gugu/session-core/acp/client';

/**
 * Keep the page cache raw: projecting individual pages would retain a detached notice after its source arrives.
 *
 * `tail`: the page is the newest one. Asked for by the reader (opening the conversation, sending, returning to the
 * bottom) it replaces what is held. Asked for only because the connection came back (`'resume'`), it is merged when it
 * reaches what is held: the reader may be pages up in the history, and a link that dropped for a second must not take
 * those pages away. When the newest page no longer reaches them (more was written meanwhile than one page holds), a
 * merge would leave a hole, so it replaces as before.
 */
export function mergeNativeRecordPage(previous: NativeSessionRecord | null, answer: NativeSessionRecord, mode: 'poll' | 'older' | 'newer' | 'tail', tail: boolean | 'resume'): NativeSessionRecord {
  // The revision list answers one question about what was held then; it is not part of what is held.
  const { revisions: _revisions, ...page } = answer;
  if (!previous || (previous.nativeOwnerNotificationEpoch ?? 0) !== (page.nativeOwnerNotificationEpoch ?? 0)) return page;
  if (tail) {
    const newestHeld = previous.turns.findLast(turn => turn.seq <= page.latestStoredSeq)?.seq;
    const oldestRead = page.turns[0]?.seq;
    if (tail !== 'resume' || newestHeld === undefined || oldestRead === undefined || oldestRead > newestHeld + 1) return page;
  }
  const merged = new Map(previous.turns.filter(turn => turn.seq <= page.latestStoredSeq).map(turn => [turn.id, turn]));
  for (const turn of page.turns) merged.set(turn.id, turn);
  const next = { ...page, turns: [...merged.values()].sort((a, b) => a.seq - b.seq),
    hasNewer: mode === 'older' ? previous.hasNewer : page.hasNewer,
    activeTurn: mode === 'older' ? previous.activeTurn : page.activeTurn,
    nextCursor: mode === 'older' || !previous.turns.length ? page.nextCursor : previous.nextCursor };
  const origins = new Map(previous.turns.map((turn, index) => [turn.id, previous.originTurnIds[index] ?? turn.id]));
  page.turns.forEach((turn, index) => origins.set(turn.id, page.originTurnIds[index] ?? turn.id));
  next.originTurnIds = next.turns.map(turn => origins.get(turn.id)!);
  const revisions = new Map<string, number>();
  previous.turnRevisions?.forEach((revision, index) => revisions.set(previous.turns[index]!.id, revision));
  page.turnRevisions?.forEach((revision, index) => revisions.set(page.turns[index]!.id, revision));
  // Known for every turn, or not kept at all: a turn of unknown revision could never be found stale.
  if (next.turns.every(turn => revisions.has(turn.id))) next.turnRevisions = next.turns.map(turn => revisions.get(turn.id)!);
  else delete next.turnRevisions;
  return next;
}

/** Every held turn carries the revision it was read at: what is held can be checked instead of read again. */
export function keepsRevisions(record: NativeSessionRecord | null): record is NativeSessionRecord & { turnRevisions: number[] } {
  return !!record && record.turns.length > 0 && record.turnRevisions?.length === record.turns.length;
}

/**
 * Compare what is held from `from` on with the host's revision list. A held turn the host no longer has is let go; one
 * the host rewrote since is `stale`, to be read again (`replaceNativeRecordTurns`). Turns before `from` are not judged.
 */
export function checkNativeRevisions(record: NativeSessionRecord & { turnRevisions: number[] }, revisions: ReadonlyArray<readonly [number, number]>, from: number): { record: NativeSessionRecord; stale: number[] } {
  const current = new Map(revisions.map(([seq, revision]) => [seq, revision]));
  const keep: number[] = [], stale: number[] = [];
  record.turns.forEach((turn, index) => {
    const revision = current.get(turn.seq);
    if (turn.seq < from || revision !== undefined) keep.push(index);
    if (turn.seq >= from && revision !== undefined && revision !== record.turnRevisions[index]) stale.push(turn.seq);
  });
  if (keep.length === record.turns.length) return { record, stale };
  return { stale, record: { ...record, turns: keep.map(index => record.turns[index]!), originTurnIds: keep.map(index => record.originTurnIds[index] ?? record.turns[index]!.id),
    turnRevisions: keep.map(index => record.turnRevisions[index]!) } };
}

/**
 * Put turns read again because they changed (`pages`, each a read of one turn ending at it) in place of the held
 * ones, with their new revision. A turn asked for that its page did not end with is no longer shown by the host: it
 * is let go, or it would be found stale on every check.
 */
export function replaceNativeRecordTurns(record: NativeSessionRecord, asked: readonly number[], pages: readonly NativeSessionRecord[]): NativeSessionRecord {
  const read = new Map<number, { turn: TranscriptTurn; revision: number | undefined; origin: string | undefined }>();
  for (const page of pages) {
    const turn = page.turns.at(-1);
    if (turn && asked.includes(turn.seq) && (record.nativeOwnerNotificationEpoch ?? 0) === (page.nativeOwnerNotificationEpoch ?? 0))
      read.set(turn.seq, { turn, revision: page.turnRevisions?.at(-1), origin: page.originTurnIds.at(-1) });
  }
  const gone = new Set(asked.filter(seq => !read.has(seq)));
  const kept = record.turns.flatMap((turn, index) => gone.has(turn.seq) ? [] : [{ index, turn, fresh: read.get(turn.seq) }]);
  const turnRevisions = kept.map(({ index, fresh }) => fresh ? fresh.revision : record.turnRevisions?.[index]);
  const next: NativeSessionRecord = { ...record, turns: kept.map(({ turn, fresh }) => fresh?.turn ?? turn),
    originTurnIds: kept.map(({ index, turn, fresh }) => fresh?.origin ?? record.originTurnIds[index] ?? turn.id) };
  if (turnRevisions.every(revision => revision !== undefined)) next.turnRevisions = turnRevisions as number[];
  else delete next.turnRevisions;
  return next;
}

/** The turn this row is drawn from, when a page sent it as its folded form: the one to read again. A row's id starts with its turn's. */
export function heldTurnOf(record: NativeSessionRecord | null, itemId: string): TranscriptTurn | null {
  return record?.turns.find(turn => itemId.startsWith(`${turn.id}:`) && turnHeld(turn)) ?? null;
}

/**
 * Put turns read again (`pages`, each a read of one turn) in the place of the held ones. Nothing else of the record
 * moves: such a page describes one turn, not where the conversation stands. A page of another history is passed over.
 */
export function fillNativeRecordTurns(record: NativeSessionRecord | null, pages: readonly NativeSessionRecord[]): NativeSessionRecord | null {
  if (!record) return null;
  const whole = new Map<string, TranscriptTurn>(), revisions = new Map<string, number | undefined>();
  for (const page of pages) {
    const turn = page.turns.at(-1);
    if (!turn || (record.nativeOwnerNotificationEpoch ?? 0) !== (page.nativeOwnerNotificationEpoch ?? 0)) continue;
    whole.set(`${turn.seq}/${turn.id}`, turn); revisions.set(`${turn.seq}/${turn.id}`, page.turnRevisions?.at(-1));
  }
  if (!record.turns.some(turn => whole.has(`${turn.seq}/${turn.id}`) && turnHeld(turn))) return record;
  const turns = record.turns.map(turn => turnHeld(turn) ? whole.get(`${turn.seq}/${turn.id}`) ?? turn : turn);
  // A filled turn is the host's turn as it is now: it carries the revision of that read.
  const turnRevisions = record.turnRevisions && turns.map((turn, index) => turn === record.turns[index] ? record.turnRevisions![index] : revisions.get(`${turn.seq}/${turn.id}`));
  const next: NativeSessionRecord = { ...record, turns };
  if (turnRevisions?.every(revision => revision !== undefined)) next.turnRevisions = turnRevisions as number[];
  else delete next.turnRevisions;
  return next;
}

export function projectNativeRecord(record: NativeSessionRecord | null): NativeSessionRecord | null {
  if (!record) return null;
  const origins = new Map(record.turns.map((turn, index) => [turn.id, record.originTurnIds[index] ?? turn.id]));
  const shown = projectOwnerNotifications(record.turns, record.activeTurn, origins);
  // Revisions belong to the held turns, not to the projected ones drawn from them.
  const { turnRevisions: _turnRevisions, revisions: _revisions, ...rest } = record;
  return { ...rest, ...shown, originTurnIds: shown.turns.map(turn => origins.get(turn.id)!) };
}
