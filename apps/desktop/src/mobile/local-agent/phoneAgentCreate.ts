import { taskFlowText } from '@/components/session-watch/task-flow-catalog'

export interface PhoneAgentCreateAttempt {
  version: 1
  id: string
  ownerId: string
  deviceId: string
  name: string
  prompt: string
  model: string
  chatId?: string
}

export interface PhoneAgentCreated {
  sessionId: string
  agentUserId: string
  chatId?: string
  birthGroup?: { chatId: string; status: 'joined' | 'pending_approval' | 'failed'; error?: string }
}

type CreationStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const storageKey = (ownerId: string, deviceId: string) => `gugu:phone-agent-create:v1:${ownerId}:${deviceId}`
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0

/** Preserve the same request and words after a lost reply; never create a second identity on retry. */
export function readPhoneAgentCreateAttempt(ownerId: string, deviceId: string, storage: CreationStorage = window.localStorage): PhoneAgentCreateAttempt | null {
  const raw = storage.getItem(storageKey(ownerId, deviceId))
  if (!raw) return null
  let value: Partial<PhoneAgentCreateAttempt>
  try {
    value = JSON.parse(raw) as Partial<PhoneAgentCreateAttempt>
  } catch {
    throw new Error(taskFlowText('errors.phoneCreateRecordIncomplete'))
  }
  if (value.version !== 1 || value.ownerId !== ownerId || value.deviceId !== deviceId
    || !text(value.id) || !text(value.name) || !text(value.prompt) || !text(value.model)
    || (value.chatId !== undefined && !text(value.chatId))) throw new Error(taskFlowText('errors.phoneCreateRecordIncomplete'))
  return value as PhoneAgentCreateAttempt
}

export function forgetPhoneAgentCreateAttempt(attempt: PhoneAgentCreateAttempt, storage: CreationStorage = window.localStorage): void {
  const saved = readPhoneAgentCreateAttempt(attempt.ownerId, attempt.deviceId, storage)
  if (saved && saved.id !== attempt.id) throw new Error(taskFlowText('errors.phoneCreateRecordChanged'))
  storage.removeItem(storageKey(attempt.ownerId, attempt.deviceId))
}
