// @@@5856 转发的出处 ——「引自:某某线」(product spec「跨线引用别处的内容时在界面上留痕」)。
//
// 一条消息的出处是它自己的属性,不会变:replica `forwardedSource(messageId)`,account 作用域(chat.forwarded_source 是
// SECURITY INVOKER,看得见什么由读者定),`fresh: Infinity`,没人画它 10 分钟后放掉,不进快照(随消息数增长)。
// 每条消息一次 RPC(chat.forwarded_source 只收一个 id)。
//
// 三态:还没读到 = unknown(画「引自 …」那块药丸大小的占位);读到、没有出处或读者看不见那条线 = value `null`
// (只显「转发」);读失败 = error(抛出,❌ 吞成「转发」—— 一次网络抖动不该静默降级成「没有出处」)。
import { chatDb } from './supabase'
import { replica } from './replica'

export type ForwardedSource = { chatId: string; kind: string; name: string | null }

async function readForwardedSource(messageId: string): Promise<ForwardedSource | null> {
  const { data, error } = await chatDb.rpc('forwarded_source', { p_message_id: messageId })
  if (error) throw new Error(error.message)
  const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | undefined
  const chatId = typeof row?.source_chat_id === 'string' ? row.source_chat_id : null
  if (!chatId) return null
  return {
    chatId,
    kind: typeof row?.source_chat_kind === 'string' ? row.source_chat_kind : 'group',
    name: typeof row?.source_chat_name === 'string' ? row.source_chat_name : null,
  }
}

export const forwardedSource = replica({
  name: 'forwardedSource',
  scope: 'account',
  read: (_owner: string, messageId: string) => readForwardedSource(messageId),
  // A message's source never changes.
  fresh: Infinity,
  keep: 10 * 60_000,
})
