import { chatDb } from './supabase'
import type { PersonalConversationStateReceipt } from './hideListedConversation'

export type PersonalConversationUndo = PersonalConversationStateReceipt & { hide_operation_id: string; restored: boolean }

/** Undo only this hide's personal intent; newer hides and clears retain their authority. */
export async function undoListedConversation(chatId: string, hideOperationId: string, operationId: string): Promise<PersonalConversationUndo> {
  const { data, error } = await chatDb.rpc('undo_my_conversation_hide', {
    p_chat_id: chatId, p_hide_operation_id: hideOperationId, p_operation_id: operationId,
  })
  if (error) throw new Error(error.message)
  if (!data || data.chat_id !== chatId || data.operation_id !== operationId || data.hide_operation_id !== hideOperationId
    || typeof data.restored !== 'boolean' || typeof data.account_revision !== 'string' || !/^(0|[1-9]\d*)$/.test(data.account_revision)
    || data.restored && data.hidden_at !== null
    || data.hidden_at !== null && (typeof data.hidden_at !== 'string' || !Number.isFinite(Date.parse(data.hidden_at)))) {
    throw new Error('Undoing conversation hiding was not confirmed')
  }
  return { chat_id: chatId, operation_id: operationId, hide_operation_id: hideOperationId,
    hidden_at: data.hidden_at, restored: data.restored, account_revision: data.account_revision }
}
