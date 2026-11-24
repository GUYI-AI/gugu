import { useEffect } from 'react'
import type { MessageReferenceTarget } from '@gugu/session-shared/markdown/dialect'
import { readMessageReference, widgetForOriginal, type WidgetOriginMessage } from '../../lib/widgetRegistry'
import { replica, useReplica, type Replica } from '../../lib/replica'
import { useChatStore } from '../../store/chatContext'

// A card or widget mounted again (back in a conversation) shows its last read in the first frame while it is read again,
// instead of a loading frame. Kept for half an hour after nothing shows it: these are many and small.
const KEEP_MS = 30 * 60_000

const messageReference = replica({
  name: 'messageReference',
  scope: 'account',
  read: (owner: string, target: MessageReferenceTarget) => readMessageReference(target, owner),
  keep: KEEP_MS,
})
const widgetOriginal = replica({
  name: 'widgetOriginal',
  scope: 'account',
  read: (_owner: string, message: WidgetOriginMessage) => widgetForOriginal(message),
  keep: KEEP_MS,
})

// What can change a read: its message retracted, its chat's members or the chat itself — in the chat it reads, not every
// message of the account (a new message changes no quote).
const CHANGES = ['message_deleted', 'chat_members_changed', 'chat_changed'] as const

/** The read for this request: its value, the Error of a read that failed, or undefined while it is not read yet. */
function useAccountRead<Q, T>(model: Replica<[Q], T>, request: Q, chatOf: (request: Q, value: T | undefined) => string | undefined): T | Error | undefined {
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const reading = useReplica(model, [request])
  const value = reading.state === 'value' ? reading.value : undefined
  const chatId = chatOf(request, value)
  const key = JSON.stringify(request)
  useEffect(() => subscribeAccountRevision(CHANGES, operations => {
    // Not yet known (a widget quote before its first read): any change may be its.
    if (!chatId || operations.some(operation => (operation.payload as { chat_id?: unknown } | null)?.chat_id === chatId)) void model.refresh(JSON.parse(key) as Q)
  }), [subscribeAccountRevision, chatId, model, key])
  return reading.state === 'error' ? reading.error : value
}

const referenceChat = (target: MessageReferenceTarget, read: Awaited<ReturnType<typeof readMessageReference>> | undefined) =>
  target.kind === 'message' ? target.chatId : read?.status === 'readable' ? read.message.chat_id : undefined
export const useMessageReference = (target: MessageReferenceTarget) => useAccountRead(messageReference, target, referenceChat)
// The read is keyed by these fields alone: a row's receipts, delivery or reactions changing is not a new read, which would
// drop the widget's page until it is read again.
export const useWidgetOriginal = ({ id, chat_id, content }: WidgetOriginMessage) =>
  useAccountRead(widgetOriginal, { id, chat_id, content }, original => original.chat_id)
