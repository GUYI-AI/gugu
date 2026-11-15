import type { ChatCommands } from '@gugu/session-chat-ui'
import type { MessageItem } from '@gugu/core/shared/types/chat'

/** A task timeline's slot for one message the agent sent to people, waiting to be drawn by the chat's MessageBody. */
export type SentMessageSlot = {
  root: HTMLElement
  message: MessageItem
  commands: () => ChatCommands | undefined
  onSize: (size: { width: number; height: number }) => void
}

/** `id`: this slot, apart from any other drawing the same message (one task open in two views). */
let slots: readonly (SentMessageSlot & { id: number })[] = []
let nextSlot = 0
const listeners = new Set<() => void>()
const changed = () => { for (const listener of listeners) listener() }

/** The timeline (in whichever React root it runs) hands its slot over; the returned function takes it back. */
export function offerSentMessageSlot(slot: SentMessageSlot): () => void {
  const id = ++nextSlot
  slots = [...slots, { ...slot, id }]
  changed()
  return () => { slots = slots.filter(entry => entry.id !== id); changed() }
}

export const subscribeSentMessageSlots = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
export const sentMessageSlots = () => slots
