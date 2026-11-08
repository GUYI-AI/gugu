import { eq } from 'drizzle-orm';
import { recentActionName, type TranscriptItem, type TranscriptTurn } from '@gugu/session-core/acp';
import { db } from '@main/db/client';
import { sessions } from '@main/db/schema';
import { readStoredTurns } from './session-turn-store';

const MAX_CHARS = 48_000;
const MAX_MESSAGE_CHARS = 8_000;

function turnLines(turn: TranscriptTurn): string[] {
  const lines: string[] = [];
  let tools: string[] = [];
  const flushTools = () => {
    if (tools.length) lines.push(`(tools used: ${tools.join(', ')})`);
    tools = [];
  };
  const walk = (items: readonly TranscriptItem[]) => {
    for (const item of items) {
      if (item.kind === 'message') {
        const text = item.text.trim();
        if (!text) continue;
        flushTools();
        const cut = text.length > MAX_MESSAGE_CHARS ? `${text.slice(0, MAX_MESSAGE_CHARS)}\n[message cut]` : text;
        lines.push(`${item.role === 'user' ? 'Person' : 'Agent'}: ${cut}`);
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

/** The newest turns before `before` that fit the budget, oldest first. */
async function recentLines(sessionId: string, before: number): Promise<{ lines: string[]; cut: boolean }> {
  const lines: string[] = [];
  let used = 0;
  let cursor: number | null = before;
  while (cursor !== null) {
    const page = await readStoredTurns(sessionId, { before: cursor });
    for (const turn of [...page.turns].reverse()) {
      const next = turnLines(turn);
      const size = next.reduce((sum, line) => sum + line.length + 1, 0);
      if (used + size > MAX_CHARS) return { lines, cut: true };
      used += size;
      lines.unshift(...next);
    }
    cursor = page.nextCursor;
  }
  return { lines, cut: false };
}

/**
 * 引擎那条会话没了之后(restart-session),新引擎要知道的前文。
 *
 * 只要会话记着 `priorTurnsBefore`,每次启动都给同样的这一段:走系统位的引擎在 resume 时不会记得上一次的系统提示词,
 * 走用户级载体的那几家按字节比对(cell.endReplay),不会重复送。所以边界是落库的序号,❌ 不是一次性标记。
 */
export async function priorConversationBlock(sessionId: string): Promise<string | null> {
  const [row] = await db.select({ config: sessions.config }).from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const before = row?.config?.priorTurnsBefore;
  if (before === undefined) return null;
  const { lines, cut } = await recentLines(sessionId, before);
  // 首轮没跑完就没有回合行,记着的那句首轮就是全部前文。
  const said = lines.length ? lines : row?.config?.firstUtterance?.trim() ? [`Person: ${row.config.firstUtterance.trim()}`] : [];
  if (!said.length) return null;
  return [
    '<gugu_prior_conversation>',
    'The engine lost its record of this task, so you are a new engine session. This is what happened earlier in this task. It is history: it has already been done, so do not redo or repeat any of it, and act only on the next message you receive. Tools are listed by name only; check the current state before relying on what they did.',
    ...(cut ? ['[Earlier part omitted for length.]'] : []),
    ...said,
    '</gugu_prior_conversation>',
  ].join('\n');
}
