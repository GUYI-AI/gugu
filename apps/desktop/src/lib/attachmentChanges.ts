import { useSyncExternalStore } from 'react'

// A declared attachment's bytes arrived (or were refused) after its message: the server tells every reader of the
// message (message_file_changed, a durable account revision, replayed after being offline). Bubbles read it again on
// that signal; none of them asks on a timer. Counted per message for this account's run.
const changes = new Map<string, number>()
const listeners = new Set<() => void>()

export function noteAttachmentChanged(messageId: string): void {
  changes.set(messageId, (changes.get(messageId) ?? 0) + 1)
  for (const listener of listeners) listener()
}

export function subscribeAttachmentChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** How many times this message's file changed since the run began: 0 means what the message said still holds. */
export function attachmentChangeCount(messageId: string | undefined): number {
  return messageId ? changes.get(messageId) ?? 0 : 0
}

export function useAttachmentChange(messageId: string | undefined): number {
  return useSyncExternalStore(subscribeAttachmentChanges, () => attachmentChangeCount(messageId))
}

export function forgetAttachmentChanges(): void {
  changes.clear()
}
