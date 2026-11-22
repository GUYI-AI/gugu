// @@@5856 话题分栏的纯函数 —— 单独一个文件是 react-refresh 的要求(一个文件只导出组件),
// 也让引文的取法能被单独判真假。
import type { MessageItem } from '@gugu/core/shared/types/chat'

/** 引用条的文本:与主线同形(一行引文 + 省略)。引用的是话题里的一句话,所以它留在分栏自己的输入框上。 */
export function quotePrefixOf(message: Pick<MessageItem, 'content'>): string {
  const firstLine = (message.content ?? '').split('\n')[0] ?? ''
  return `> ${firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine}`
}

/** Source eligibility matches server privacy rules; outbox waits for local sources. */
export type TopicSourceCandidate =
  Pick<MessageItem, 'id' | 'seq' | 'local_send_state' | 'is_whisper' | 'retracted_at' | 'content_type'>

export function canSourceTopic(message: TopicSourceCandidate): boolean {
  // 话题名截自来源正文且对全线可见 ⇒ 悄悄话与撤回不许当来源
  // (20260919001500 / 20260919003000 两条迁移硬拒)。
  if (message.is_whisper || message.retracted_at || message.local_send_state === 'failed') return false
  return true
}
