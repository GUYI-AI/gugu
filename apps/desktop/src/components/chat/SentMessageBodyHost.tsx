import { memo, startTransition, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { SentMessageBody } from '@/session/renderer/lib/chat/sent-message-body'
import { sentMessageSlots, subscribeSentMessageSlots } from './sentMessageSlots'

// A row entering or leaving the virtual list changes the slot list on most scroll frames: only that slot draws.
const SlotBody = memo(SentMessageBody)

/**
 * Draws every offered slot from the app's own tree, where the signed-in account and the chat store are: the desktop
 * task page runs in a React root of its own, and MessageBody's file cards and reference tags read both. Mounted once.
 */
export function SentMessageBodyHost() {
  // Rows enter the virtual list inside its animation frame. Drawing their bodies there holds that scroll frame, so they
  // draw just after it, interruptibly; the row has already reserved the slot's height.
  const [current, setCurrent] = useState(sentMessageSlots)
  useEffect(() => {
    const update = () => startTransition(() => setCurrent(sentMessageSlots()))
    update()
    return subscribeSentMessageSlots(update)
  }, [])
  return current.map(slot => createPortal(<SlotBody message={slot.message} commands={slot.commands()} onSize={slot.onSize} />, slot.root, slot.id))
}
