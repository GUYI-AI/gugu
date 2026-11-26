import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { HOST_PROMPT_HASH } from '../acp/native-prompt-key';

/**
 * The turn a running agent is in, as its runtime holds it, shown in place of the record's copy of that turn.
 *
 * A record gets a turn line by line, after the agent wrote it; the runtime has the whole turn as it happens (calls in
 * flight, the message being written). So while the runtime has a turn in progress, the timeline shows the runtime's,
 * and the record's turns at the tail that are that same turn step aside. Which ones are: the turns at the tail that
 * share an id with it (a tool call, an agent message, the person's message), or that open with the same prompt
 * (records that number their lines themselves share no ids with the runtime). Being still open says nothing: a
 * record without turn ends keeps its last turn open until the next prompt is written. The first turn from the end
 * that is neither stays, and so does everything before it. Once the runtime's turn ends (`runtime` null), the
 * record's turns are shown as they are (`withDrawnTurns`), from when the record holds that turn (`recordHolds`).
 */

/**
 * `turns` without their tail turns that are `turn` as another source holds it (`sameTurnAs`), for whoever draws `turn`
 * itself. `before`: the turns that had ended when `turn` started (`endedTurnIds`, taken then). None of them is a copy
 * of it, whatever it shares: the same words sent again open a turn alike, and their receipt is the same too.
 */
export function withoutCopiesOf(turns: readonly TranscriptTurn[], turn: TranscriptTurn, before?: ReadonlySet<string>): TranscriptTurn[] {
  const same = sameTurnAs(turn);
  let end = turns.length;
  while (end > 0 && !before?.has(turns[end - 1]!.id) && !startedBefore(turns[end - 1]!, turn) && same(turns[end - 1]!)) end -= 1;
  return turns.slice(0, end);
}

/**
 * A record's line is written after its runtime opened the turn, both on this machine's clock; a record's clock may
 * count whole seconds. So a turn that started more than that before `turn` did is an earlier turn, whatever it shares
 * with it and whenever it was read: this holds for a record read late, where `before` (taken when `turn` started)
 * holds nothing. A turn without a time says nothing.
 */
const RECORD_CLOCK_MS = 1_000;
export function startedBefore(other: TranscriptTurn, turn: TranscriptTurn): boolean {
  return other.startedAt !== undefined && turn.startedAt !== undefined && other.startedAt < turn.startedAt - RECORD_CLOCK_MS;
}

/** A turn of the runtime drawn in place of the record's copies of it. `before`: see `withoutCopiesOf`. */
export type DrawnTurn = { turn: TranscriptTurn; before: ReadonlySet<string> };

/** `turns` with each drawn turn, oldest first, in place of its copies at the tail. */
export function withDrawnTurns(turns: readonly TranscriptTurn[], drawn: readonly DrawnTurn[]): TranscriptTurn[] {
  if (drawn.length === 0) return [...turns];
  let rest: TranscriptTurn[] = [...turns];
  // The newest first: its copies are the ones at the tail.
  for (let index = drawn.length - 1; index >= 0; index -= 1) rest = withoutCopiesOf(rest, drawn[index]!.turn, drawn[index]!.before);
  return [...rest, ...drawn.map((one) => one.turn)];
}

/**
 * Whether the record holds a turn its runtime has ended, so the record's copy is shown from here on. An ended copy
 * does. So does any copy once the record was read as written at that end (`readToNow`): the record is then as far as
 * its agent wrote it, and an open copy is what a record without turn ends keeps. A record read to there that has a
 * later turn and no copy (it numbers nothing the runtime does and words the prompt its own way) holds it too.
 */
export function recordHolds(turns: readonly TranscriptTurn[], held: DrawnTurn, readToNow: boolean): boolean {
  const same = sameTurnAs(held.turn);
  const since = turns.filter((turn) => !held.before.has(turn.id) && !startedBefore(turn, held.turn));
  const copies = since.filter(same);
  if (copies.length > 0) return readToNow || copies.every((turn) => turn.outcome !== undefined || turn.endedAt !== undefined);
  const startedAt = held.turn.startedAt;
  return readToNow && startedAt !== undefined && since.some((turn) => turn.startedAt !== undefined && turn.startedAt >= startedAt);
}

/** The turns that have ended: what a turn starting now cannot be a copy of (`withoutCopiesOf`). */
export function endedTurnIds(turns: readonly TranscriptTurn[]): Set<string> {
  return new Set(turns.filter((turn) => turn.outcome !== undefined || turn.endedAt !== undefined).map((turn) => turn.id));
}

/**
 * Whether a turn is `turn` as another source holds it: they share an id the agent numbered (a tool call, an agent
 * message, the person's message), or open with the same prompt (records that number their lines themselves share no
 * ids with the runtime).
 */
export function sameTurnAs(turn: TranscriptTurn): (other: TranscriptTurn) => boolean {
  const keys = new Set(sameTurnKeys(turn));
  const anchor = turnAnchor(turn);
  return (other) => {
    // Both name their turn (`turnAnchor`): that alone says whether they are one turn, the same words or not.
    const theirs = anchor === null ? null : turnAnchor(other);
    if (anchor !== null && theirs !== null) return anchor === theirs;
    return sameTurnKeys(other).some((key) => keys.has(key));
  };
}

/**
 * The agent's own name for a turn, where its harness gives one to both the runtime and the record: the point a revert
 * steps back to, on the message that opened the turn (Codex: the turn id; Claude: that message's id). Null when the
 * turn carries none (a harness without one, or a runtime turn whose receipt has not come yet).
 */
export function turnAnchor(turn: Pick<TranscriptTurn, 'items'>): string | null {
  const first = turn.items.find((item): item is Extract<TranscriptItem, { kind: 'message' }> => item.kind === 'message' && item.role === 'user');
  return first?.revertAnchor ?? null;
}

const keysOf = new WeakMap<TranscriptTurn, readonly string[]>();

/** What makes two turns the same turn (`sameTurnAs`): they share one of these. A turn is immutable, so once per turn. */
export function sameTurnKeys(turn: TranscriptTurn): readonly string[] {
  let keys = keysOf.get(turn);
  if (!keys) {
    const prompt = openingPrompt(turn);
    keys = [...(prompt === null ? [] : [`prompt:${prompt}`]), ...identityKeys(turn)];
    keysOf.set(turn, keys);
  }
  return keys;
}

/**
 * What an agent itself numbered in a turn: tool calls, its messages, the person's native message; and the receipt of
 * the native prompt the person's message was sent as (`host-prompts.ts`), which the runtime and the record both carry.
 */
export function identityKeys(turn: Pick<TranscriptTurn, 'items'>): Set<string> {
  const keys = new Set<string>();
  const visit = (item: { kind?: string; id?: string; role?: string; _meta?: Record<string, unknown>; toolCallId?: string; children?: unknown[] }) => {
    if (item.toolCallId) keys.add(`tool:${item.toolCallId}`);
    if ((item.kind === 'message' || item.kind === 'thinking') && item.id) {
      const native = item.role === 'user' ? item._meta?.guguNativeMessageId : undefined;
      // An item id is `${turn id}:message:${message id}`; the turn id differs between the runtime and a record.
      const own = typeof native === 'string' ? native : /^.*?:(?:message|thinking):(.+)$/.exec(item.id)?.[1];
      if (own && !own.startsWith('auto:')) keys.add(`message:${own}`);
      const receipt = item.role === 'user' ? item._meta?.[HOST_PROMPT_HASH] : undefined;
      if (typeof receipt === 'string') keys.add(`receipt:${receipt}`);
    }
    for (const child of item.children ?? []) visit(child as typeof item);
  };
  for (const item of turn.items) visit(item as Parameters<typeof visit>[0]);
  return keys;
}

function openingPrompt(turn: TranscriptTurn): string | null {
  const first = turn.items.find((item): item is Extract<TranscriptItem, { kind: 'message' }> => item.kind === 'message' && item.role === 'user');
  const text = first?.text.replace(/\s+/g, ' ').trim();
  return text ? text : null;
}
