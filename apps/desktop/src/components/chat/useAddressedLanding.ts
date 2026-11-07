import { useEffect, useRef, type Dispatch, type MutableRefObject, type SetStateAction } from 'react'

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
