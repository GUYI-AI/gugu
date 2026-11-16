// @@@5856 转发的出处 ——「引自:某某线」(product spec「跨线引用别处的内容时在界面上留痕」)。
//
// 出处不会变:`fresh: Infinity`,account 作用域(SECURITY INVOKER),不进快照;每条消息一次 RPC(只收一个 id)。
// 三态:unknown 画药丸占位;没有出处或看不见 = value `null`(只显「转发」);读失败 = error(❌ 吞成「转发」)。
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
