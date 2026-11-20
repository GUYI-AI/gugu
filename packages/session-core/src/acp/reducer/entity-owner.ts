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

/** `contains` for a committed turn, by its index. Message and thinking ids are `${turn.id}:<local>` unless a client id. */
function committedTest(event: NormalizedEvent): (index: EntityIndex) => boolean {
  if (event.kind === 'message') {
    if (event.messageId === null) return () => false;
    const wanted = messageEntityId(LOCAL, { ...event, messageId: event.messageId });
    return wanted.startsWith(LOCAL_PREFIX) ? (index) => index.local.has(wanted.slice(LOCAL_PREFIX.length)) : (index) => index.ids.has(wanted);
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
