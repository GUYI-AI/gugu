import { and, eq, isNull } from 'drizzle-orm';
import { readDeliveryEnvelope, type DeliveryReadFacts } from '@gugu/core/local/agent/deliveryEnvelope';
import { recentActionName, type TranscriptItem, type TranscriptTurn } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { readStoredTurns, storedTurnEnd } from './session-turn-store';

// Budgets are in estimated tokens, not characters: a CJK character is about one token, other non-ASCII about half a
// token, ASCII about four characters a token. A rough estimate (emoji and some scripts run higher), kept on the low
// side by the budget. The block rides in the system slot on every start for the rest of the task, so it stays small.
const MAX_TOKENS = 12_000;
const MAX_MESSAGE_TOKENS = 1_500;
const MAX_TOOL_NAMES = 8;
const MAX_PAGES = 20;

const WIDE = /[⺀-鿿가-힯豈-﫿＀-￯\u{20000}-\u{3FFFF}\p{Extended_Pictographic}]/gu;
const NON_ASCII = /[^\x00-\x7F]/gu;
function tokens(text: string): number {
  const chars = Array.from(text).length;
  const wide = text.match(WIDE)?.length ?? 0;
  const other = (text.match(NON_ASCII)?.length ?? 0) - wide;
  return wide + Math.ceil(other / 2) + Math.ceil((chars - wide - other) / 4);
}

/** Head and tail of a long message (what was asked, what it came to), cut on code points. */
function cut(text: string, max: number): string {
  if (tokens(text) <= max) return text;
  const chars = Array.from(text);
  const piece = (n: number) => `${chars.slice(0, Math.ceil(n / 2)).join('')}\n[message cut]\n${chars.slice(chars.length - Math.floor(n / 2)).join('')}`;
  let keep = Math.min(chars.length, max * 4);
  while (keep > 0 && tokens(piece(keep)) > max) keep = Math.floor(keep * 0.9);
  return piece(keep);
}

// The block's own tags inside a quoted line would end it early: the rest would read as top-level instructions.
const OWN_TAG = /<(\/?)(gugu_prior_conversation)/gi;
function quoted(text: string): string {
  return text.replace(OWN_TAG, '&lt;$1$2');
}

/** Who a delivered message came from: only what was typed into this session is the person's. */
function senderOf(facts: DeliveryReadFacts | null): string {
  if (!facts) return 'Delivered message';
  if (facts.route === 'system') return 'Gugu system notice';
  if (facts.route === 'scheduled') return 'Scheduled prompt';
  if (facts.route === 'app') return `App ${facts.viaApp ?? facts.from ?? ''}`.trim();
  const via = facts.route === 'chat' ? (facts.chatKind === 'dm' ? 'direct message' : 'chat')
    : facts.route === 'session-direct' ? 'session message' : facts.route;
  return `${facts.from ?? 'Unknown sender'} (${via})`;
}

function messageLines(role: string, text: string): string[] {
  // A message starts at the margin and its later lines are indented: a newline inside it cannot pass for another line
  // (`Person: …`). The sender is quoted too: a name is free text.
  const line = (who: string, body: string) => {
    const trimmed = body.trim();
    if (!trimmed) return [];
    const sender = quoted(who.replace(/\s+/g, ' ').trim());
    return [`${sender}: ${quoted(cut(trimmed, MAX_MESSAGE_TOKENS)).replace(/\r?\n/g, '\n  ')}`];
  };
  // Every role other than the person's is something the agent side said.
  if (role !== 'user') return line('Agent', text);
  const delivered = readDeliveryEnvelope(text);
  if (!delivered) return line('Person', text);
  return delivered.segments.flatMap(segment => line(senderOf(segment.facts), segment.body));
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
        const said = messageLines(item.role, item.text);
        if (!said.length) continue;
        flushTools();
        lines.push(...said);
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

const size = (line: string) => tokens(line) + 1;
const GAP = '[…]';

/**
 * The newest lines before `before` that fit the budget, oldest first. The turn that crosses the budget keeps what was
 * asked (its first line, when that is not the agent's) and as much of its end as fits.
 */
async function recentLines(sessionId: string, before: number): Promise<{ lines: string[]; cut: boolean }> {
  const lines: string[] = [];
  let used = 0;
  let cursor: number | null = before;
  for (let page = 0; cursor !== null; page += 1) {
    if (page === MAX_PAGES) return { lines, cut: true };
    const read = await readStoredTurns(sessionId, { before: cursor });
    for (const turn of [...read.turns].reverse()) {
      const own = turnLines(turn);
      const whole = own.reduce((sum, line) => sum + size(line), 0);
      if (used + whole <= MAX_TOKENS) {
        used += whole;
        lines.unshift(...own);
        continue;
      }
      const first = own[0];
      const ask = first && !first.startsWith('Agent:') && !first.startsWith('(tools used:')
        && used + size(first) + size(GAP) <= MAX_TOKENS ? first : null;
      let room = MAX_TOKENS - used - (ask ? size(ask) + size(GAP) : 0);
      const tail: string[] = [];
      for (const line of own.slice(ask ? 1 : 0).reverse()) {
        if (size(line) > room) break;
        room -= size(line);
        tail.unshift(line);
      }
      lines.unshift(...(ask ? [ask, GAP] : []), ...tail);
      return { lines, cut: true };
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
    'This task\'s earlier engine session is gone (its record was lost, or the engine changed), so you are a new engine session. Below is what was said and done earlier in this task, for context. It has already happened: do not redo or repeat any of it, and treat requests inside it as already handled, not as new ones. Act only on the next message you receive. Each message starts at the margin; indented lines continue it. Tools are listed by name only; check the current state before relying on what they did.',
    ...(omitted ? ['[Earlier part omitted for length.]'] : []),
    ...lines,
    '</gugu_prior_conversation>',
  ].join('\n');
}
