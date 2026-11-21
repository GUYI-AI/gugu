import type { TranscriptTurn } from '@gugu/session-core/acp';

/**
 * 侧边聊天(运行时分叉)画哪几轮(#6762):只画**在这条分叉里开出来的**回合。
 *
 * 有的家 fork 时把来源会话的历史重放进分叉(走 `session/load` 的那几家),那是给模型的上下文,
 * ❌ 不是这条侧边聊天里说过的话。重放出来的回合没有 `startedAt`(session-core `turn.ts` 的合同:重放没有
 * 真实时钟;`background-commands.ts` 也按它认重放),这里就按它认。
 *
 * ⚠️ ❌ 按「挂上那一刻引擎里已有几轮」去切:聊天面挂上会话之前从这个视图发出的话照样会开轮
 * (运行时在收到那一刻判准入),挂上之前就答完的那一轮会被当成来源前缀整轮藏掉 —— 问了、答了,屏上什么都没有。
 */
export function sideChatOwnTurns(turns: readonly TranscriptTurn[]): TranscriptTurn[] {
  return turns.filter((turn) => turn.startedAt !== undefined);
}
