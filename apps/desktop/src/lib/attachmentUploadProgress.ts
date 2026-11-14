import { useCallback, useSyncExternalStore } from 'react'

export type AttachmentUploadProgress = { loaded: number; total?: number; attempt: number }
const values = new Map<string, AttachmentUploadProgress>()
const listeners = new Map<string, Set<() => void>>()

/** Ephemeral transport state keyed by the same ID as its optimistic message. */
export function setAttachmentUploadProgress(messageId: string, progress?: AttachmentUploadProgress): void {
  if (progress) values.set(messageId, progress)
  else values.delete(messageId)
  for (const listener of listeners.get(messageId) ?? []) listener()
}

/** #2581 How much of several files' bytes are up, in files (each file 0–1); null for none. */
export function useAttachmentsUploadShare(messageIds: readonly string[] | null): number | null {
  const key = messageIds?.join('\u0000') ?? ''
  const subscribe = useCallback((listener: () => void) => {
    const ids = key ? key.split('\u0000') : []
    for (const id of ids) {
      const set = listeners.get(id) ?? new Set<() => void>()
      listeners.set(id, set)
      set.add(listener)
    }
    return () => {
      for (const id of ids) {
        const set = listeners.get(id)
        set?.delete(listener)
        if (set && !set.size) listeners.delete(id)
      }
    }
  }, [key])
  const snapshot = useCallback(() => {
    if (!key) return null
    let share = 0
    for (const id of key.split('\u0000')) {
      const progress = values.get(id)
      if (progress?.total) share += Math.min(1, progress.loaded / progress.total)
    }
    return share
  }, [key])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
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
