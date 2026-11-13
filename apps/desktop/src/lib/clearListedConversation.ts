import { chatDb } from './supabase'
import type { PersonalConversationHiding } from './hideListedConversation'

export type PersonalConversationClear = PersonalConversationHiding & { cleared_at: string }

/** Clears only the caller's visible history; group and Agent lifecycles are separate actions. */
export async function clearListedConversation(chatId: string, operationId: string): Promise<PersonalConversationClear> {
  const { data, error } = await chatDb.rpc('delete_my_conversation', { p_chat_id: chatId, p_operation_id: operationId })
  if (error) throw new Error(error.message)
  if (!data || data.chat_id !== chatId || data.operation_id !== operationId
    || typeof data.hidden_at !== 'string' || !Number.isFinite(Date.parse(data.hidden_at))
    || typeof data.cleared_at !== 'string' || !Number.isFinite(Date.parse(data.cleared_at))
    || typeof data.account_revision !== 'string' || !/^(0|[1-9]\d*)$/.test(data.account_revision)) throw new Error('Conversation deletion was not confirmed')
  return data as PersonalConversationClear
}
