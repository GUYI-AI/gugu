import type { TranscriptItem, TranscriptTurn } from '../acp/models/turns/turn';
import { HOST_PROMPT_HASH } from '../acp/native-prompt';

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
 * record's turns are shown as they are.
 */
export function withRuntimeTurn(turns: readonly TranscriptTurn[], runtime: TranscriptTurn | null): TranscriptTurn[] {
  if (!runtime) return [...turns];
  const same = sameTurnAs(runtime);
  let end = turns.length;
  while (end > 0 && same(turns[end - 1]!)) end -= 1;
  return [...turns.slice(0, end), runtime];
}

/**
 * Whether a turn is `turn` as another source holds it: they share an id the agent numbered (a tool call, an agent
 * message, the person's message), or open with the same prompt (records that number their lines themselves share no
 * ids with the runtime).
 */
export function sameTurnAs(turn: TranscriptTurn): (other: TranscriptTurn) => boolean {
  const keys = new Set(sameTurnKeys(turn));
  return (other) => sameTurnKeys(other).some((key) => keys.has(key));
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
