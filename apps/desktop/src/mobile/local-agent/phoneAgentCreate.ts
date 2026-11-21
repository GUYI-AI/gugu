import { taskFlowText } from '@/components/session-watch/task-flow-catalog'
import type { PhoneAgentHostCall, PhoneAgentHostReply, PhoneAgentHostState } from './nativeAgent'

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

export function rememberPhoneAgentCreateAttempt(attempt: PhoneAgentCreateAttempt, storage: CreationStorage = window.localStorage): void {
  storage.setItem(storageKey(attempt.ownerId, attempt.deviceId), JSON.stringify(attempt))
}

export function forgetPhoneAgentCreateAttempt(attempt: PhoneAgentCreateAttempt, storage: CreationStorage = window.localStorage): void {
  const saved = readPhoneAgentCreateAttempt(attempt.ownerId, attempt.deviceId, storage)
  if (saved && saved.id !== attempt.id) throw new Error(taskFlowText('errors.phoneCreateRecordChanged'))
  storage.removeItem(storageKey(attempt.ownerId, attempt.deviceId))
}

/** Both local creation and remote spawn run the Node host's one durable provision + birth-group saga. */
export async function createPhoneAgent(attempt: PhoneAgentCreateAttempt, host: PhoneAgentHostState | null, invoke: (input: PhoneAgentHostCall) => Promise<PhoneAgentHostReply>): Promise<PhoneAgentCreated> {
  if (!host?.ready || host.status !== 'ready' || host.ownerId !== attempt.ownerId || host.deviceId !== attempt.deviceId) throw new Error(taskFlowText('errors.phoneNotConnected'))
  if (!attempt.name.trim() || !attempt.prompt.trim()) throw new Error(taskFlowText('errors.nameAndTaskRequired'))
  if (!attempt.model.startsWith('platform:') || !attempt.model.slice('platform:'.length)) throw new Error(taskFlowText('errors.modelRequired'))
  const reply = await invoke({ ownerId: attempt.ownerId, id: attempt.id, channel: 'sessionTimeline.sessionCreate', args: [{
    clientRequestId: attempt.id, title: attempt.name.trim(), harness: 'pi', sessionView: 'general', model: attempt.model,
    prompt: attempt.prompt.trim(), ...(attempt.chatId ? { chatId: attempt.chatId } : {}),
  }] })
  if (reply.error) throw new Error(reply.error.message)
  const result = reply.result as { conversationId?: unknown; agentUserId?: unknown; chatId?: unknown; birthGroup?: { chatId?: unknown; status?: unknown; error?: unknown } } | undefined
  if (!result || !text(result.conversationId) || !text(result.agentUserId)) throw new Error(taskFlowText('errors.agentResultIncomplete'))
  if (attempt.chatId && (result.birthGroup?.chatId !== attempt.chatId || !['joined', 'pending_approval', 'failed'].includes(String(result.birthGroup.status)))) throw new Error(taskFlowText('errors.groupJoinUnconfirmed'))
  return {
    sessionId: result.conversationId, agentUserId: result.agentUserId, ...(text(result.chatId) ? { chatId: result.chatId } : {}),
    ...(attempt.chatId ? { birthGroup: { chatId: attempt.chatId, status: result.birthGroup!.status as 'joined' | 'pending_approval' | 'failed', ...(text(result.birthGroup?.error) ? { error: result.birthGroup.error } : {}) } } : {}),
  }
}
