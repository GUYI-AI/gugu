import { useEffect } from 'react'
import { UI_EVENTS } from '@/lib/uiEvents'

/** Keep creation on the shell's existing generic or group-scoped route. */
export function requestPhoneAgentCreation(chatId?: string) {
  window.dispatchEvent(chatId
    ? new CustomEvent(UI_EVENTS.createAgentInGroup, { detail: { chatId } })
    : new Event(UI_EVENTS.createAgent))
}

export function usePhoneAgentCreation(onCreate: () => void, enabled: boolean) {
  useEffect(() => {
    if (!enabled) return
    window.addEventListener(UI_EVENTS.createAgent, onCreate)
    return () => window.removeEventListener(UI_EVENTS.createAgent, onCreate)
  }, [onCreate, enabled])
}
