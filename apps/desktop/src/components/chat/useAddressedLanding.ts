import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { isRoomChat } from '@gugu/core/shared/ui/chatModels'

/**
 * 有人叫到你时,这次打开落在第一条叫你的未读消息上,到位时闪一下。只在打开时读一次:之后读到哪,不改这次落在哪。
 * 话题分栏和群主线共用这一条:落点交给 useConversationScrollMemory 的 landOn(藏着等它就位),读多少由看见多少决定。
 */
export function useAddressedLanding({ chatId, firstAddressedMessageId, rowIds, setFlashMessageId, flashTimerRef }: {
  chatId: string | null
  firstAddressedMessageId: string | null | undefined
  rowIds: readonly string[]
  setFlashMessageId: Dispatch<SetStateAction<string | null>>
  flashTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
}): string | null {
  const landing = useRef<{ chatId: string | null; messageId: string | null } | null>(null)
  if (landing.current?.chatId !== chatId) landing.current = { chatId, messageId: firstAddressedMessageId ?? null }
  const messageId = landing.current.messageId
  const arrived = !!messageId && rowIds.includes(messageId)
  useEffect(() => {
    if (!arrived || !messageId) return
    landing.current = { chatId, messageId: null }
    setFlashMessageId(messageId)
    if (flashTimerRef.current) clearTimeout(flashTimerRef.current)
    flashTimerRef.current = setTimeout(() => setFlashMessageId(null), 1400)
  }, [arrived, messageId, chatId, setFlashMessageId, flashTimerRef])
  return messageId
}

/**
 * 一个群的主线这一次打开:和话题一样落在第一条叫到你的消息上;没人叫你就照 #6530 停在最新处。
 * @@@6530 因为有新消息才点开的这一次停在最新处,不回上次读到一半的位置。由会话自己的未读数决定:这次打开的未读入口
 * (unreadEntry)在会话激活之后才捕获,拿它来丢旧位置已经晚了。
 */
export function useMainLineOpening({ chat, unreadEntry, rowIds, setFlashMessageId, flashTimerRef }: {
  chat: ChatItem | null | undefined
  unreadEntry: unknown
  rowIds: readonly string[]
  setFlashMessageId: Dispatch<SetStateAction<string | null>>
  flashTimerRef: MutableRefObject<ReturnType<typeof setTimeout> | null>
}): { landOn: string | null; discardSaved: boolean } {
  const landOn = useAddressedLanding({ chatId: chat?.id ?? null, rowIds, setFlashMessageId, flashTimerRef,
    firstAddressedMessageId: chat && isRoomChat(chat.kind) ? chat.unread_locator?.first_addressed_message_id : null })
  return { landOn, discardSaved: !!unreadEntry || (chat?.unread_count ?? 0) > 0 }
}
