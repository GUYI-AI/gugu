import { useEffect, useMemo, useState } from 'react'
import type { MessageReferenceTarget } from '@gugu/session-shared/markdown/dialect'
import { readMessageReference, widgetForOriginal, type WidgetOriginMessage } from '../../lib/widgetRegistry'
import { useAuth } from '../../store/auth'
import { useChatStore } from '../../store/chatContext'

// The last read of each target per account this session: a card or widget mounted again (back in a conversation) shows
// it in its first frame while it is read again, instead of a loading frame. Failures are not kept.
function lastReads<T>() {
  const reads = new Map<string, T>()
  return { get: (key: string) => reads.get(key), set(key: string, value: T) {
    reads.delete(key)
    reads.set(key, value)
    if (reads.size > 256) reads.delete(reads.keys().next().value!)
  } }
}
const references = lastReads<Awaited<ReturnType<typeof readMessageReference>>>()
const originals = lastReads<Awaited<ReturnType<typeof widgetForOriginal>>>()

// What can change a read: its message retracted, its chat's members or the chat itself — in the chat it reads, not every
// message of the account (a new message changes no quote).
const CHANGES = ['message_deleted', 'chat_members_changed', 'chat_changed'] as const

function useAccountRead<Q, T>(request: Q, load: (request: Q, userId: string) => Promise<T>, last: ReturnType<typeof lastReads<T>>,
  chatOf: (request: Q, value: T | undefined) => string | undefined) {
  const { user } = useAuth()
  const { subscribeAccountRevision } = useChatStore('subscribeAccountRevision')
  const [revision, setRevision] = useState(0)
  const [read, setRead] = useState<{ key: string; value: T | Error } | null>(null)
  const targetKey = JSON.stringify(request)
  const lookup = useMemo(() => JSON.parse(targetKey) as Q, [targetKey])
  const userId = user?.id
  const known = JSON.stringify([userId, lookup])
  const key = JSON.stringify([userId, lookup, revision])
  const chatId = chatOf(lookup, last.get(known))
  useEffect(() => subscribeAccountRevision(CHANGES, operations => {
    // Not yet known (a widget quote before its first read): any change may be its.
    if (!chatId || operations.some(operation => (operation.payload as { chat_id?: unknown } | null)?.chat_id === chatId)) setRevision(value => value + 1)
  }), [subscribeAccountRevision, chatId])
  useEffect(() => {
    if (!userId) return
    let live = true
    void load(lookup, userId).then(value => {
      last.set(known, value)
      if (live) setRead({ key, value })
    }, error => {
      if (live) setRead({ key, value: error instanceof Error ? error : new Error(String(error)) })
    })
    return () => { live = false }
  }, [key, known, lookup, userId, load, last])
  return read?.key === key ? read.value : last.get(known)
}

const referenceChat = (target: MessageReferenceTarget, read: Awaited<ReturnType<typeof readMessageReference>> | undefined) =>
  target.kind === 'message' ? target.chatId : read?.status === 'readable' ? read.message.chat_id : undefined
export const useMessageReference = (target: MessageReferenceTarget) => useAccountRead(target, readMessageReference, references, referenceChat)
export const useWidgetOriginal = (message: WidgetOriginMessage) => useAccountRead(message, widgetForOriginal, originals, original => original.chat_id)
