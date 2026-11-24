import { useEffect, useRef } from 'react'
import { scheduleComposerFocus } from '../../lib/focusComposer'
import { useChatStore } from '../../store/chatContext'
import { APP_COMPOSE_EVENT, type AppComposeDetail } from '../../session/shared/extensions/app-runtime-protocol'

/**
 * An App took the person to this tab's chat (desktop or phone) — a `gugu.dispatch` draft (the chat shell put the text
 * after the chat's draft, MainLayout): the tab gets out from over the chat (`makeWay`), so what the App pointed at is
 * seen. After a compose the chat's composer is focused when it is the active chat. Nothing here sends.
 */
export function useSlotMakesWay(chatId: string, makeWay: () => void): void {
  const { activeChatId } = useChatStore('activeChatId')
  const latest = useRef({ makeWay, activeChatId })
  latest.current = { makeWay, activeChatId }
  useEffect(() => {
    const onCompose = (event: Event) => {
      if ((event as CustomEvent<AppComposeDetail>).detail?.chatId !== chatId) return
      latest.current.makeWay()
      if (chatId === latest.current.activeChatId) scheduleComposerFocus('quote-attached')
    }
    window.addEventListener(APP_COMPOSE_EVENT, onCompose)
    return () => {
      window.removeEventListener(APP_COMPOSE_EVENT, onCompose)
    }
  }, [chatId])
}
