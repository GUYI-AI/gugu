import { OPEN_LINK_TARGET } from '../../apps/desktop/src/lib/guguLinks'

/** Chats asked to open as the main conversation (openLinkTarget({ kind: 'chat' })), answered as the shell would. */
export function captureOpenedChats(): { readonly chatIds: string[]; stop(): void } {
  const chatIds: string[] = []
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<{ target: { kind: string; chatId?: string }; resolve(value?: unknown): void }>).detail
    if (detail.target.kind !== 'chat' || !detail.target.chatId) return
    event.preventDefault()
    chatIds.push(detail.target.chatId)
    detail.resolve()
  }
  window.addEventListener(OPEN_LINK_TARGET, listener)
  return { chatIds, stop: () => window.removeEventListener(OPEN_LINK_TARGET, listener) }
}
