import { contextUsageBelongsTo } from '@shared/core/sessions/session-config';
import type { Session } from '@shared/core/sessions/sessions';

/**
 * #7342 活会话没有读数时(停下了、还在起、刚重开还没跑完一轮),输入框画会话记录里那份最后读数 ——
 * 前提是它**属于此刻这条会话**:同一条原生会话(重来 / 换计费路后上下文从零开始)。
 *
 * 换了模型(owner 2026-11-27「行，我认同」):已用量是这段对话本身,照旧画;分母换成此刻模型的上下文窗口
 * (`currentWindow`),说不出窗口就不画数。`currentModelId`:此刻的模型 —— 活会话自报的那个,或起动这一步要设进去的那个;
 * null = 说不出(用记录里的模型起),这时记录那份原样画。
 */
export function recordedContextUsage(
  record: Pick<Session, 'contextUsage' | 'providerSessionId'> | undefined,
  currentModelId: string | null,
  currentWindow?: number
): { contextUsed: number; contextSize: number; cost: null } | null {
  const usage = record?.contextUsage;
  if (!usage || !contextUsageBelongsTo(usage, record.providerSessionId)) return null;
  // 花费是那个进程里的累计,不跟读数一起落盘:停下后说不出,就不说。
  if (currentModelId === null || usage.modelId === currentModelId) return { contextUsed: usage.used, contextSize: usage.size, cost: null };
  return currentWindow && currentWindow > 0 ? { contextUsed: usage.used, contextSize: currentWindow, cost: null } : null;
}
