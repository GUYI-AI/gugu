import type { TranscriptItem, TranscriptTurn } from '../models/turns';
import { messageEntityId, makeThinkingId } from './ids';
import { SESSION_PLAN_ID } from '../models/plan';
import type { NormalizedEvent } from './normalized-event';

/** Entity identity, rather than whichever turn happens to be active, owns updates. */
export function findEntityOwner(
  transcript: { active: TranscriptTurn | null; committed: readonly TranscriptTurn[] },
  event: NormalizedEvent,
): TranscriptTurn | undefined {
  if (event.kind !== 'message' && event.kind !== 'thinking' && event.kind !== 'tool_call' && event.kind !== 'tool_update' && event.kind !== 'plan') return;
  const contains = (turn: TranscriptTurn): boolean => {
    // 消息 / 思维要问的是「这个 id 在不在这回合里」,而那个 id 只由**回合 id 与事件**决定,与条目无关
    // ⇒ 在遍历外算一次。原先它写在 `some` 里,于是每个条目都重建一个字符串再比 —— 而这条路是
    // 「每来一个流式片段、每个条目走一次」(见 `reduce`,#1181)。
    const wanted = event.kind === 'message'
      ? event.messageId === null ? null : messageEntityId(turn.id, { ...event, messageId: event.messageId })
      : event.kind === 'thinking'
        ? event.messageId === null ? null : makeThinkingId(turn.id, event.messageId)
        : null;
    const visit = (items: readonly TranscriptItem[]): boolean => items.some(item => {
      if (event.kind === 'message' || event.kind === 'thinking') return wanted !== null && item.id === wanted;
      if (event.kind === 'plan') return item.kind === 'create-plan-tool-call' && item.planId === (event.planId ?? SESSION_PLAN_ID);
      if ('toolCallId' in item && item.toolCallId === event.toolCallId && item.kind !== 'subagent-done-tool-call') return true;
      return 'children' in item && item.children !== undefined && visit(item.children);
    });
    return visit(turn.items);
  };
  if (transcript.active && contains(transcript.active)) return transcript.active;
  const has = committedTest(event);
  if (transcript.committed.length === 0 || !has(committedUnion(transcript.committed))) return;
  for (let i = transcript.committed.length - 1; i >= 0; i--) if (has(entityIndex(transcript.committed[i]))) return transcript.committed[i];
}

/**
 * @@@committed-entity-index - a committed turn is searched once per event that is not in the active turn, which on a
 * record replay is nearly every event: walking each committed item every time made opening a long session quadratic
 * (a 277 MB Claude record took most of a minute). Turns are immutable, so a committed turn's ids are indexed once per
 * turn object and later lookups are set probes. Same answers as `contains` above.
 */
export interface EntityIndex { ids: Set<string>; local: Set<string>; toolCallIds: Set<string>; planIds: Set<string> }
const indexes = new WeakMap<TranscriptTurn, EntityIndex>();

export function entityIndex(turn: TranscriptTurn): EntityIndex {
  let index = indexes.get(turn);
  if (index) return index;
  index = { ids: new Set(), local: new Set(), toolCallIds: new Set(), planIds: new Set() };
  const prefix = `${turn.id}:`;
  const visit = (items: readonly TranscriptItem[]): void => {
    for (const item of items) {
      index!.ids.add(item.id);
      if (item.id.startsWith(prefix)) index!.local.add(item.id.slice(prefix.length));
      if (item.kind === 'create-plan-tool-call') index!.planIds.add(item.planId);
      if ('toolCallId' in item && item.kind !== 'subagent-done-tool-call') index!.toolCallIds.add(item.toolCallId);
      if ('children' in item && item.children !== undefined) visit(item.children);
    }
  };
  visit(turn.items);
  indexes.set(turn, index);
  return index;
}

/**
 * @@@committed-union - most events belong to the active turn or to no turn yet (every new tool call), and for those the
 * backward scan above probed every committed turn: still O(events x turns) per replay. The union of the committed turns'
 * indexes answers "in none of them" with one probe. It is kept per session (keyed by the first turn) and only grows, so
 * after a revert it may still hold ids of turns that are gone: a hit then falls through to the exact scan, a miss never lies.
 * `turnsOf` keeps, per tool call id, the seqs of the committed turns that held it, for `committedSlotsWith`.
 */
type Union = { index: EntityIndex; members: WeakSet<TranscriptTurn>; turnsOf: Map<string, number[]>; last: readonly TranscriptTurn[] };
const unions = new WeakMap<TranscriptTurn, Union>();
const synced = new WeakMap<readonly TranscriptTurn[], Union>();

function committedUnion(committed: readonly TranscriptTurn[]): EntityIndex {
  return syncUnion(committed).index;
}

function syncUnion(committed: readonly TranscriptTurn[]): Union {
  const known = synced.get(committed);
  if (known) return known;
  let union = unions.get(committed[0]);
  if (!union) unions.set(committed[0], union = { index: { ids: new Set(), local: new Set(), toolCallIds: new Set(), planIds: new Set() },
    members: new WeakSet(), turnsOf: new Map(), last: [] });
  // A new history array is the last one with a turn appended or one turn replaced: comparing slots skips the rest cheaply.
  const { last } = union;
  for (let i = 0; i < committed.length; i++) {
    const turn = committed[i];
    if (turn === last[i] || union.members.has(turn)) continue;
    union.members.add(turn);
    const index = entityIndex(turn);
    for (const key of ['ids', 'local', 'toolCallIds', 'planIds'] as const) for (const id of index[key]) union.index[key].add(id);
    for (const id of index.toolCallIds) {
      const seqs = union.turnsOf.get(id);
      if (!seqs) union.turnsOf.set(id, [turn.seq]);
      else if (!seqs.includes(turn.seq)) seqs.push(turn.seq);
    }
  }
  union.last = committed;
  synced.set(committed, union);
  return union;
}

/**
 * Where in `committed` the turns holding a call with this id (`findToolCallNode` would find it) are, oldest first. A
 * subagent's events land on its launch card in an old turn: looking that turn up by id keeps a replay from scanning every
 * committed turn per subagent event. Same answer as filtering `committed` by `entityIndex(turn).toolCallIds`.
 */
export function committedSlotsWith(committed: readonly TranscriptTurn[], toolCallId: string): number[] {
  if (committed.length === 0) return [];
  const seqs = syncUnion(committed).turnsOf.get(toolCallId);
  if (!seqs) return [];
  const slots: number[] = [];
  for (const seq of seqs) {
    const slot = slotOfSeq(committed, seq);
    if (slot >= 0 && entityIndex(committed[slot]).toolCallIds.has(toolCallId)) slots.push(slot);
  }
  return slots.length > 1 ? slots.sort((a, b) => a - b) : slots;
}

/** Committed turns are sorted by seq (`assertTranscriptInvariants`). */
function slotOfSeq(committed: readonly TranscriptTurn[], seq: number): number {
  let low = 0;
  let high = committed.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const at = committed[middle].seq;
    if (at === seq) return middle;
    if (at < seq) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

/** `contains` for a committed turn, by its index. Message and thinking ids are `${turn.id}:<local>` unless a client id. */
function committedTest(event: NormalizedEvent): (index: EntityIndex) => boolean {
  if (event.kind === 'message') {
    if (event.messageId === null) return () => false;
    const wanted = messageEntityId(LOCAL, { ...event, messageId: event.messageId });
    if (!wanted.startsWith(LOCAL_PREFIX)) return (index) => index.ids.has(wanted);
    const local = wanted.slice(LOCAL_PREFIX.length);
    return (index) => index.local.has(local);
  }
  if (event.kind === 'thinking') {
    if (event.messageId === null) return () => false;
    const local = makeThinkingId(LOCAL, event.messageId).slice(LOCAL_PREFIX.length);
    return (index) => index.local.has(local);
  }
  if (event.kind === 'plan') {
    const planId = event.planId ?? SESSION_PLAN_ID;
    return (index) => index.planIds.has(planId);
  }
  const toolCallId = (event as { toolCallId: string }).toolCallId;
  return (index) => index.toolCallIds.has(toolCallId);
}

/** A turn id no real turn has, so a built id that starts with it is a turn-local id and one that does not is a client id. */
const LOCAL = '\u0000turn';
const LOCAL_PREFIX = `${LOCAL}:`;
