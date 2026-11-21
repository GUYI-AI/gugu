import { getCurrentAuthUserId } from '@/lib/supabase'
import { SessionInputFailureError, withSessionInputDeadline } from '@/lib/sessionInputOutbox'
import { invokePhoneHost } from './phoneHostRpc'
import { taskFlowText } from '@/components/session-watch/task-flow-catalog'

export type StoredPhoneTaskSend = { version: 1; id: string; text: string }
export interface PhoneTaskComposer {
  getState(): { text: string; attachments?: readonly unknown[] }
  setText(text: string): void
}
/** Restore only an empty composer. New words or selected attachments always belong to the user. */
export function restorePhoneTaskDraft(composer: PhoneTaskComposer, text: string): boolean {
  const current = composer.getState()
  if (current.text.length || current.attachments?.length) return false
  composer.setText(text)
  return true
}
type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const listeners = new Set<(key: string) => void>()
export const phoneTaskSendKey = (ownerId: string, deviceId: string, sessionId: string): string => `gugu:phone-task-send:v1:${ownerId}:${deviceId}:${sessionId}`

export function readPhoneTaskSend(ownerId: string, deviceId: string, sessionId: string, storage: StorageLike = window.localStorage): StoredPhoneTaskSend | null {
  const raw = storage.getItem(phoneTaskSendKey(ownerId, deviceId, sessionId))
  if (raw === null) return null
  let pending: Partial<StoredPhoneTaskSend> | null
  try { pending = JSON.parse(raw) as Partial<StoredPhoneTaskSend> | null }
  catch { throw new Error(taskFlowText('errors.sendRecordIncomplete')) }
  if (!pending || pending.version !== 1 || typeof pending.id !== 'string' || !pending.id || typeof pending.text !== 'string' || !pending.text.trim()) throw new Error(taskFlowText('errors.sendRecordIncomplete'))
  return pending as StoredPhoneTaskSend
}

export function subscribePhoneTaskSend(listener: (key: string) => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const changed = (key: string) => { for (const listener of listeners) listener(key) }

/** Legacy draft recovery has the same bounded wait, while admission keeps observing the original receipt. */
async function withPhoneInputDeadline<T>(sending: Promise<T>): Promise<T> {
  try { return await withSessionInputDeadline(sending, 12_000) }
  catch (error) {
    if (error instanceof SessionInputFailureError) throw Object.assign(new Error(taskFlowText('errors.noResult')), { code: 'host_call_timeout' })
    throw error
  }
}

/** Preserve an unacknowledged task input across reloads; a retry cannot admit it twice. */
export async function sendPhoneTaskText(deviceId: string, sessionId: string, text: string, invoke = invokePhoneHost, storage: StorageLike = window.localStorage): Promise<unknown> {
  const ownerId = await getCurrentAuthUserId()
  return withPhoneInputDeadline(sendOwnedPhoneTask(ownerId, deviceId, sessionId, text, invoke, storage))
}

/** An explicit retry confirms the saved admission without adding another optimistic user message. */
export async function retryPhoneTaskSend(ownerId: string, deviceId: string, sessionId: string, id: string, invoke = invokePhoneHost, storage: StorageLike = window.localStorage): Promise<unknown> {
  if (await getCurrentAuthUserId() !== ownerId) throw new Error(taskFlowText('errors.accountChanged'))
  const pending = readPhoneTaskSend(ownerId, deviceId, sessionId, storage)
  if (!pending || pending.id !== id) throw new Error(taskFlowText('errors.pendingDraftChanged'))
  return withPhoneInputDeadline(sendOwnedPhoneTask(ownerId, deviceId, sessionId, pending.text, invoke, storage))
}

async function sendOwnedPhoneTask(ownerId: string, deviceId: string, sessionId: string, text: string, invoke: typeof invokePhoneHost, storage: StorageLike): Promise<unknown> {
  const key = phoneTaskSendKey(ownerId, deviceId, sessionId)
  const pending = readPhoneTaskSend(ownerId, deviceId, sessionId, storage)
  const body = text.trim()
  if (!body) throw new Error(taskFlowText('errors.taskRequired'))
  if (pending && pending.text !== body) throw new Error(taskFlowText('errors.sendPending'))
  const request: StoredPhoneTaskSend = pending ?? { version: 1, id: crypto.randomUUID(), text: body }
  if (!pending) { storage.setItem(key, JSON.stringify(request)); changed(key) }
  const result = await invoke<{ accepted?: unknown }>(deviceId, 'sessionTimeline.sessionSend', [{ conversationId: sessionId, text: request.text, clientRequestId: request.id }], request.id)
  if (result?.accepted !== true) throw new Error(taskFlowText('errors.sendUnconfirmed'))
  if (await getCurrentAuthUserId() === ownerId) {
    const current = storage.getItem(key)
    if (current && (JSON.parse(current) as StoredPhoneTaskSend).id === request.id) { storage.removeItem(key); changed(key) }
  }
  return result
}
