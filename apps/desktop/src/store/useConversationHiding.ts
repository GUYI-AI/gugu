import { useCallback, useMemo } from 'react'
import type { PersonalConversationHiding, PersonalConversationStateReceipt } from '../lib/hideListedConversation'
import { chatService } from '../lib/chat'
import { createConversationHider } from '../lib/conversationHider'
import { currentAuthSessionSignal } from '../lib/authSessionLoss'
import { i18n } from '../i18n'
import { clearListedConversation } from '../lib/clearListedConversation'
import { undoListedConversation, type PersonalConversationUndo } from '../lib/undoListedConversation'

/** Shared phone/desktop actions; hiding preserves the complete addressable directory. */
export function useConversationHiding(userId: string | null, projection: {
  confirmPersonalHiding: (accountId: string, receipt: PersonalConversationStateReceipt) => Promise<void>
}) {
  const confirm = projection.confirmPersonalHiding
  const hide = useMemo(() => createConversationHider<PersonalConversationHiding>({
    hide: chatService.hideConversation,
    confirm: async (accountId, receipt) => {
      try { await confirm(accountId, receipt) }
      catch (cause) { throw new Error(i18n.t('chatList.hiddenRefreshFailed', { ns: 'messaging' }), { cause }) }
    },
    boundary: currentAuthSessionSignal, operationId: () => crypto.randomUUID(),
    storage: localStorage, storageKey: 'conversation-hide',
  }), [confirm])
  const clear = useMemo(() => createConversationHider({
    hide: clearListedConversation, confirm, boundary: currentAuthSessionSignal,
    operationId: () => crypto.randomUUID(), storage: localStorage, storageKey: 'conversation-clear',
  }), [confirm])
  const undo = useMemo(() => {
    const operations = new Map<string, (accountId: string, chatId: string) => Promise<PersonalConversationUndo | undefined>>()
    return (accountId: string, chatId: string, hideOperationId: string) => {
      let operation = operations.get(hideOperationId)
      if (!operation) {
        operation = createConversationHider<PersonalConversationUndo>({
          hide: (id, operationId) => undoListedConversation(id, hideOperationId, operationId), confirm,
          boundary: currentAuthSessionSignal, operationId: () => crypto.randomUUID(),
          storage: localStorage, storageKey: `conversation-hide-undo:${hideOperationId}`,
        })
        operations.set(hideOperationId, operation)
      }
      return operation(accountId, chatId).then(receipt => {
        if (receipt) operations.delete(hideOperationId)
        return receipt
      })
    }
  }, [confirm])
  const hideConversation = useCallback(async (chatId: string) => {
    if (!userId) throw new Error('Not authenticated')
    return await hide(userId, chatId)
  }, [userId, hide])
  const clearConversation = useCallback(async (chatId: string) => {
    if (!userId) throw new Error('Not authenticated')
    await clear(userId, chatId)
  }, [userId, clear])
  const undoConversationHide = useCallback(async (chatId: string, hideOperationId: string) => {
    if (!userId) throw new Error('Not authenticated')
    return await undo(userId, chatId, hideOperationId)
  }, [userId, undo])
  return { hideConversation, clearConversation, undoConversationHide }
}
