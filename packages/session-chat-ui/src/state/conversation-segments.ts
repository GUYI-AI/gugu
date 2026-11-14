import { isGuguSilence } from '@gugu/core/local/agent/silenceMarker';
import { hookSpeakerOfNotice } from '@gugu/session-core/acp';
import { toolCallName } from '@gugu/session-core/acp/client';
import { isQuestionOrPlanToolName } from '@gugu/session-core/session-record/question-tools';
import { processHookNotice } from '@session-chat/lib/hook-notice';
import type { ChatItem, ChatMessage, TranscriptTurn } from '@session-chat/model';
import { turnProcessId } from './turn-fold';

export type ConversationSegment = {
  kind: 'segment';
  id: string;
  items: ChatItem[];
  startedAt?: number;
  endedAt?: number;
  live: boolean;
  idleMs: number;
  /** The idle stretch before a continued turn (#2587). Final as soon as the turn resumes, so it counts while live too. */
  resumedIdleMs: number;
  /**
   * A line a woken run continued opens and closes under keys of its own (#2587): one while that run goes (its own key
   * reads inverted while live, `turnProcessExpanded`, so the line would flip at the wake and again at the end), and a
   * fresh one once it is over, so the finished line is closed whatever the reader did while it was still going (owner
   * 2026-11-13:「你跑完怎么不合起来」). Opened after it finished, it stays open until another wake continues it.
   */
  toggleId?: string;
  fullReply?: true;
};
export type ConversationBlock = { kind: 'input'; item: ChatItem } | ConversationSegment;

/**
 * A finished subagent, a finished background command and a context compaction are part of the agent's own work:
 * they continue the segment they land in and never open a new one (owner 2026-11-13, #2587:「三类消息之前是会创建
 * 新的气泡段落，现在是接续之前气泡段落」). They fold into the process like any step. A failed compaction keeps its
 * own row: the user has to see that nothing was compacted.
 */
export function continuesConversationSegment(item: ChatItem): boolean {
  return item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call'
    || (item.kind === 'compaction' && item.status !== 'failed');
}

/** A turn joined onto the one before it; `resumedAfterIdle` holds the idle stretch (maybe 0) keyed by the first joined item. */
export type ContinuedTurn = TranscriptTurn & { resumedAfterIdle?: ReadonlyMap<string, number> };

/**
 * A turn the agent opened by itself because one of its tasks finished (or its context was compacted) carries on the
 * turn before it (#2587). Turns opened by people — the owner, an A2A or group delivery, a schedule — still split
 * (owner:「A2A 消息或者用户消息造成的分割，还是会分割消息气泡」).
 *
 * A task that finishes while the turn before is still going is recorded in that turn; the turn the agent opens
 * afterwards to answer it starts with its own work, not with the completion (mac1 real window 2026-11-13: a 3 s
 * command finished inside a 12 s turn and its wake opened a second segment). That turn carries on too.
 */
export function continuesPreviousTurn(turn: TranscriptTurn, previous: TranscriptTurn | undefined): boolean {
  if (turn.initiator !== 'agent' || (turn.trigger !== undefined && turn.trigger.kind !== 'agent')) return false;
  const first = (turn.items as readonly ChatItem[])[0];
  if (first === undefined) return false;
  if (continuesConversationSegment(first)) return true;
  // An owner notification is a turn of its own the agent's send writes (trigger `agent` too), not a wake.
  return turn.trigger?.kind === 'agent' && !(first.kind === 'message' && first.ownerNotification)
    && previous !== undefined && leaves(previous.items as readonly ChatItem[]).some(item =>
      item.kind === 'subagent-done-tool-call' || item.kind === 'background-command-done-tool-call');
}

/** Only a cleanly finished turn is continued: a stopped or failed one keeps its own ending. */
export function canBeContinued(turn: TranscriptTurn): boolean {
  return turn.outcome === undefined || turn.outcome.kind === 'done';
}

/** `turn` appended to `previous`: one turn under `previous`'s id, so its process line, fold state and anchors stay put. */
export function joinContinuedTurn(previous: ContinuedTurn, turn: TranscriptTurn): ContinuedTurn {
  const first = turn.items[0];
  const idle = previous.endedAt !== undefined && turn.startedAt !== undefined ? Math.max(0, turn.startedAt - previous.endedAt) : 0;
  const resumedAfterIdle = new Map(previous.resumedAfterIdle);
  if (first !== undefined) resumedAfterIdle.set(first.id, idle);
  const terminals = previous.terminals || turn.terminals ? [...(previous.terminals ?? []), ...(turn.terminals ?? [])] : undefined;
  const { endedAt: _endedAt, outcome: _outcome, ...rest } = previous;
  return {
    ...rest,
    items: [...previous.items, ...turn.items],
    ...(turn.endedAt !== undefined ? { endedAt: turn.endedAt } : {}),
    ...(turn.outcome !== undefined ? { outcome: turn.outcome } : {}),
    ...(terminals ? { terminals } : {}),
    resumedAfterIdle,
  };
}

/**
 * While a continued turn runs, the committed turns it continues move into the live tier with it, so the process line
 * already on screen is the one that turns live again — ❌ a second line that only merges once the run ends.
 * The committed tier gives the run back when the turn commits (its tail then appends as one joined turn).
 */
export function withContinuedActiveTurn<T extends { committed: readonly TranscriptTurn[]; active: TranscriptTurn | null }>(projected: T): T {
  const { committed, active } = projected;
  if (!active || committed.length === 0 || !canBeContinued(committed[committed.length - 1]!) || !continuesPreviousTurn(active, committed[committed.length - 1])) return projected;
  let start = committed.length - 1;
  while (start > 0 && continuesPreviousTurn(committed[start]!, committed[start - 1]) && canBeContinued(committed[start - 1]!)) start--;
  const run = joinContinuedTurns(committed.slice(start));
  if (run.length !== 1) return projected;
  return { ...projected, committed: committed.slice(0, start), active: joinContinuedTurn(run[0]!, active) };
}

/** Folds every continued turn into the turn it continues (see `continuesPreviousTurn`). */
export function joinContinuedTurns(turns: readonly TranscriptTurn[]): ContinuedTurn[] {
  const out: ContinuedTurn[] = [];
  for (const turn of turns) {
    const previous = out.at(-1);
    if (previous !== undefined && canBeContinued(previous) && continuesPreviousTurn(turn, previous)) out[out.length - 1] = joinContinuedTurn(previous, turn);
    else out.push(turn);
  }
  return out;
}

export function conversationSpoken(item: ChatItem): item is ChatMessage {
  return item.kind === 'message' && item.role === 'assistant' && !!item.text.trim()
    && !isGuguSilence(item.text) && !processHookNotice(item);
}

/** Authentic event clocks only. Older provider replays deliberately have no wall clock. */
export function conversationEventAt(item: ChatItem): number | undefined {
  if ('at' in item && typeof item.at === 'number') return item.at;
  if (item.kind === 'compaction') return item.startedAt;
  return undefined;
}

function leaves(items: readonly ChatItem[]): ChatItem[] {
  return items.flatMap(item => item.kind === 'tool-group' ? leaves(item.children) : [item]);
}

/**
 * The replay prototype's render/closeSeg, before choosing any reply. Never split only
 * the process after choosing a turn-wide reply: that moves pre-steer words below the input.
 * Successful send projections are inserted next to their calls by withSentReplies.
 */
export function planConversationSegments(turn: TranscriptTurn, active: boolean): ConversationBlock[] {
  const blocks: ConversationBlock[] = [];
  let segment: ConversationSegment | undefined;
  let startedAt = turn.startedAt;
  let boundary: string | undefined;
  let hadSegment = false;
  let pendingInput = false;
  let previousAt: number | undefined;
  let pendingStop: { owner: ConversationSegment; items: ChatItem[] } | undefined;
  let resumedIdle = 0;
  let resumedAt: string | undefined;
  let resumed: { segment: ConversationSegment; at: string } | undefined;
  const open = (): ConversationSegment => {
    if (!segment) {
      segment = { kind: 'segment', id: boundary ? `${turnProcessId(turn.id)}@${boundary}` : turnProcessId(turn.id),
        items: [], live: false, idleMs: 0, resumedIdleMs: 0, ...(startedAt !== undefined ? { startedAt } : {}) };
      blocks.push(segment);
      hadSegment = true;
    }
    return segment;
  };
  const close = (at: number | undefined, id: string) => {
    // The boundary starts the next segment; it is not work performed by the old one.
    // Prototype render() measures a closed segment through its last agent event.
    segment = undefined;
    previousAt = undefined;
    startedAt = at;
    boundary = id;
  };
  const finishStop = (continueAt?: number, split = false) => {
    if (!pendingStop) return;
    const { owner, items } = pendingStop;
    pendingStop = undefined;
    if (split && owner.items.length) {
      close(conversationEventAt(items[0]) ?? continueAt, items[0].id);
      open().items.push(...items);
    } else {
      owner.items.push(...items);
      segment = owner;
    }
  };
  for (const item of leaves(turn.items as readonly ChatItem[])) {
    if ('parentToolCallId' in item && item.parentToolCallId) continue;
    const at = conversationEventAt(item);
    const hook = processHookNotice(item);
    if (hook?.hookName === 'Stop') {
      // A send may have closed before its silence marker. At this Stop boundary
      // the marker belongs to that sent reply, not to a new empty Stop owner.
      const beforeSilence = blocks.at(-2);
      if (segment?.items.length && segment.items.every(part => part.kind === 'message' && part.role === 'assistant'
        && (!part.text.trim() || isGuguSilence(part.text))) && beforeSilence?.kind === 'segment'
        && beforeSilence.items.some(part => part.kind === 'message' && (part.id.includes(':sent:') || part.ownerNotification))) {
        beforeSilence.items.push(...segment.items);
        blocks.pop();
        segment = beforeSilence;
      }
      const previous = blocks.at(-1);
      const owner = pendingStop?.owner ?? segment ?? (previous?.kind === 'segment' && !pendingInput ? previous : open());
      if (owner.items.some(conversationSpoken)) owner.fullReply = true;
      if (pendingStop) pendingStop.items.push(item);
      else pendingStop = { owner, items: [item] };
      continue;
    }
    const resume = (turn as ContinuedTurn).resumedAfterIdle?.get(item.id);
    if (resume !== undefined) { resumedIdle += resume; resumedAt = item.id; }
    const activity = item.kind === 'thinking' || conversationSpoken(item) || ('toolCallId' in item
      && item.kind !== 'subagent-done-tool-call' && item.kind !== 'background-command-done-tool-call');
    const boundaryItem = (item.kind === 'message' && item.role === 'user') || item.kind === 'context-reset'
      || (item.kind === 'compaction' && !continuesConversationSegment(item));
    if (pendingStop && !activity && !boundaryItem) { pendingStop.items.push(item); continue; }
    finishStop(at, activity);
    if (item.kind === 'message' && item.role === 'user') {
      // Later completion updates to an earlier tool cannot extend the sealed process clock.
      if (segment && at !== undefined) segment.endedAt = at;
      close(hadSegment ? at : turn.startedAt ?? at, item.id);
      if (!hadSegment) boundary = undefined;
      blocks.push({ kind: 'input', item });
      pendingInput = true;
      continue;
    }
    const question = 'toolCallId' in item && isQuestionOrPlanToolName(toolCallName(item));
    // Context and engine boundaries keep their chronological place outside process folds.
    if (question || (item.kind === 'compaction' && !continuesConversationSegment(item)) || item.kind === 'context-reset'
      || (item.kind === 'session-notice' && item.code !== 'provider-notice' && !hookSpeakerOfNotice(item))) {
      close(at, item.id);
      blocks.push({ kind: 'input', item });
      pendingInput = false;
      continue;
    }
    const current = open();
    current.resumedIdleMs += resumedIdle;
    resumedIdle = 0;
    if (resumedAt !== undefined) { resumed = { segment: current, at: resumedAt }; resumedAt = undefined; }
    if (item.kind === 'session-notice' && at !== undefined && previousAt !== undefined) current.idleMs += Math.max(0, at - previousAt);
    current.items.push(item);
    current.endedAt = 'completedAt' in item ? item.completedAt ?? at : at;
    previousAt = at;
    pendingInput = false;
    if (item.kind === 'message' && (item.id.includes(':sent:') || item.ownerNotification)) close(at, item.id);
  }
  finishStop();
  if (segment) {
    segment.live = active;
    // A wake held after a Stop hook so far rests in the line that hook belongs to.
    if (resumedAt !== undefined) resumed = { segment, at: resumedAt };
    if (resumed?.segment === segment) segment.toggleId = `${segment.id}~${resumed.at}${active ? '' : ':ended'}`;
    // Message.at is the first streamed chunk; the turn's completion is the authentic final clock.
    if (!active && turn.endedAt !== undefined) segment.endedAt = turn.endedAt;
  } else if (active && pendingInput && blocks.at(-1)?.kind === 'input') {
    // A real steer has arrived, but no subsequent event yet: one process line, no empty body.
    open().live = true;
  }
  if (active && !blocks.length) open().live = true;
  return blocks;
}
