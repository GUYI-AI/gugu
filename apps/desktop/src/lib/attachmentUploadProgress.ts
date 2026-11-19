import { useCallback, useSyncExternalStore } from 'react'

/** An attachment's bytes going up after its message: how far, or failed (with a retry while this device still has them). */
export type AttachmentUploadProgress = { loaded: number; total?: number; attempt: number; failed?: false } | { failed: true; retry?: () => void; reason?: string }
const values = new Map<string, AttachmentUploadProgress>()
const listeners = new Map<string, Set<() => void>>()

/** Ephemeral transport state keyed by the same ID as its message; the message's delivery and reads never read it. */
export function setAttachmentUploadProgress(messageId: string, progress?: AttachmentUploadProgress): void {
  if (progress) values.set(messageId, progress)
  else values.delete(messageId)
  for (const listener of listeners.get(messageId) ?? []) listener()
}

export function failAttachmentUploadProgress(messageId: string, retry?: () => void, reason?: string): void {
  setAttachmentUploadProgress(messageId, { failed: true, retry, reason })
}

export function useAttachmentUploadProgress(messageId: string): AttachmentUploadProgress | undefined {
  const subscribe = useCallback((listener: () => void) => {
    const set = listeners.get(messageId) ?? new Set<() => void>()
    listeners.set(messageId, set)
    set.add(listener)
    return () => { set.delete(listener); if (!set.size) listeners.delete(messageId) }
  }, [messageId])
  const snapshot = useCallback(() => values.get(messageId), [messageId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
