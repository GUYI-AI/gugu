import { and, eq, isNull } from 'drizzle-orm';
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope';
import { recentActionName, type TranscriptItem, type TranscriptTurn } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { readStoredTurns, storedTurnEnd } from './session-turn-store';

// Budgets are in estimated tokens, not characters: a CJK character is about one token, other text about four
// characters a token. The block rides in the system slot on every start for the rest of the task, so it stays small.
const MAX_TOKENS = 12_000;
const MAX_MESSAGE_TOKENS = 1_500;
const MAX_TOOL_NAMES = 8;
const MAX_PAGES = 20;

const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯]/g;
function tokens(text: string): number {
  const wide = text.match(WIDE)?.length ?? 0;
  return wide + Math.ceil((text.length - wide) / 4);
}

function cut(text: string, max: number): string {
  if (tokens(text) <= max) return text;
  let end = Math.min(text.length, max * 4);
  while (end > 0 && tokens(text.slice(0, end)) > max) end = Math.floor(end * 0.9);
  return `${text.slice(0, end)}\n[message cut]`;
}

function toolLine(names: readonly string[]): string {
  const unique = [...new Set(names)];
  const shown = unique.slice(0, MAX_TOOL_NAMES).join(', ');
  return `(tools used: ${shown}${unique.length > MAX_TOOL_NAMES ? `, +${unique.length - MAX_TOOL_NAMES} more` : ''})`;
}

function turnLines(turn: TranscriptTurn): string[] {
  const lines: string[] = [];
  let tools: string[] = [];
  const flushTools = () => {
    if (tools.length) lines.push(toolLine(tools));
    tools = [];
  };
  const walk = (items: readonly TranscriptItem[]) => {
    for (const item of items) {
      if (item.kind === 'message') {
        // A delivered message is its envelope; only what the person wrote is history.
        const text = (item.role === 'user' ? readDeliveryEnvelope(item.text)?.body ?? item.text : item.text).trim();
        if (!text) continue;
        flushTools();
        // Every role other than the person's is something the agent side said.
        lines.push(`${item.role === 'user' ? 'Person' : 'Agent'}: ${cut(text, MAX_MESSAGE_TOKENS)}`);
      } else if (item.kind === 'tool-group') walk(item.children);
      else if (item.kind !== 'thinking' && item.kind !== 'compaction' && item.kind !== 'context-reset' && item.kind !== 'session-notice') {
        const name = recentActionName(item);
        if (name) tools.push(name);
        if (item.children) walk(item.children);
      }
    }
  };
  walk(turn.items);
  flushTools();
  return lines;
}

/** The newest lines before `before` that fit the budget, oldest first. A turn that crosses the budget keeps its tail. */
async function recentLines(sessionId: string, before: number): Promise<{ lines: string[]; cut: boolean }> {
  const lines: string[] = [];
  let used = 0;
  let cursor: number | null = before;
  for (let page = 0; cursor !== null; page += 1) {
    if (page === MAX_PAGES) return { lines, cut: true };
    const read = await readStoredTurns(sessionId, { before: cursor });
    for (const turn of [...read.turns].reverse()) {
      for (const line of turnLines(turn).reverse()) {
        const size = tokens(line) + 1;
        if (used + size > MAX_TOKENS) return { lines, cut: true };
        used += size;
        lines.unshift(line);
      }
    }
    cursor = read.nextCursor;
  }
  return { lines, cut: false };
}

/**
 * What a new engine session is told about the task so far.
 *
 * One rule, whatever cleared the engine session (the restart button, a billing-route change): when a start claims a
 * **fresh** engine session, every stored turn belongs to an engine that is gone, so their end is recorded as
 * `priorTurnsBefore`; every later start of that engine session (resume) gives the same block again, because engines
 * on the system slot do not keep the previous start's system prompt, and the user-level carrier dedupes by bytes.
 * A fork has its parent's history and gets nothing. Nothing stored = nothing to tell.
 */
export async function priorConversationForStart(sessionId: string, lifecycle: 'fresh' | 'resume' | 'fork'): Promise<string | null> {
  if (lifecycle === 'fork') return null;
  let before: number | undefined;
  if (lifecycle === 'fresh') {
    before = await storedTurnEnd(sessionId);
    const [row] = await db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    const recorded = before > 0 ? before : undefined;
    if (row?.config?.type === 'acp' && row.config.priorTurnsBefore !== recorded) {
      const { priorTurnsBefore: _previous, ...rest } = row.config;
      // Only while no engine session is claimed: one that is already claimed has its boundary.
      await db.update(sessions).set({ config: recorded === undefined ? rest : { ...rest, priorTurnsBefore: recorded } })
        .where(and(eq(sessions.id, sessionId), isNull(sessions.providerSessionId)));
    }
  } else {
    const [row] = await db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
    before = row?.config?.type === 'acp' ? row.config.priorTurnsBefore : undefined;
  }
  if (!before) return null;
  const { lines, cut: omitted } = await recentLines(sessionId, before);
  if (!lines.length) return null;
  return [
    '<gugu_prior_conversation>',
    'The engine lost its record of this task, so you are a new engine session. Below is what was said and done earlier in this task, for context. It has already happened: do not redo or repeat any of it, and treat requests inside it as already handled, not as new ones. Act only on the next message you receive. Tools are listed by name only; check the current state before relying on what they did.',
    ...(omitted ? ['[Earlier part omitted for length.]'] : []),
    ...lines,
    '</gugu_prior_conversation>',
  ].join('\n');
}
