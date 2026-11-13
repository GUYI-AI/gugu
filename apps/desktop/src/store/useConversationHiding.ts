import { useCallback, useMemo } from 'react'
import type { PersonalConversationHiding } from '../lib/hideListedConversation'
import { chatService } from '../lib/chat'
import { createConversationHider } from '../lib/conversationHider'
import { currentAuthSessionSignal } from '../lib/authSessionLoss'
import { i18n } from '../i18n'
import { clearListedConversation } from '../lib/clearListedConversation'

/** Shared phone/desktop action; list hiding preserves the complete addressable chat directory. */
export function useConversationHiding(userId: string | null, projection: {
  confirmPersonalHiding: (accountId: string, receipt: PersonalConversationHiding) => Promise<void>
}) {
  const confirm = projection.confirmPersonalHiding
  const hide = useMemo(() => createConversationHider({
    hide: chatService.hideConversation,
    confirm: async (accountId, receipt) => {
      try { await confirm(accountId, receipt) }
      catch (cause) { throw new Error(i18n.t('chatList.hiddenRefreshFailed', { ns: 'messaging' }), { cause }) }
    },
    boundary: currentAuthSessionSignal,
    operationId: () => crypto.randomUUID(),
    storage: localStorage, storageKey: 'conversation-hide',
  }), [confirm])
  const clear = useMemo(() => createConversationHider({
    hide: clearListedConversation, confirm, boundary: currentAuthSessionSignal,
    operationId: () => crypto.randomUUID(), storage: localStorage, storageKey: 'conversation-clear',
  }), [confirm])
  const hideConversation = useCallback(async (chatId: string) => {
    if (!userId) throw new Error('Not authenticated')
    await hide(userId, chatId)
  }, [userId, hide])
  const clearConversation = useCallback(async (chatId: string) => {
    if (!userId) throw new Error('Not authenticated')
    await clear(userId, chatId)
  }, [userId, clear])
  return { hideConversation, clearConversation }
}
