import type { SessionpageSessionCreateRequest } from '@gugu/session-core/session-record/contract'
import { taskFlowText } from '@/components/session-watch/task-flow-catalog'
import { forgetPhoneAgentCreateAttempt, readPhoneAgentCreateAttempt } from './phoneAgentCreate'

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
const key = (ownerId: string, deviceId: string) => `gugu:phone-session-create:v1:${ownerId}:${deviceId}`

/** A lost creation reply must reuse the same intent, even after leaving the shared composer. */
export function readPhoneSessionCreate(ownerId: string, deviceId: string, storage: StorageLike = window.localStorage): SessionpageSessionCreateRequest | null {
  const raw = storage.getItem(key(ownerId, deviceId))
  if (raw) {
    let request: SessionpageSessionCreateRequest
    try {
      request = JSON.parse(raw) as SessionpageSessionCreateRequest
    } catch {
      // 值坏了(手改/跨版本脏数据)按同一条「记录不完整」处理,❌ 漏出原生 SyntaxError。
      throw new Error(taskFlowText('errors.createRecordIncomplete'))
    }
    if (!request.clientRequestId || !request.prompt?.trim() || request.harness !== 'pi') throw new Error(taskFlowText('errors.createRecordIncomplete'))
    return request
  }
  const previous = readPhoneAgentCreateAttempt(ownerId, deviceId, storage)
  return previous ? { clientRequestId: previous.id, title: previous.name.trim(), harness: 'pi', prompt: previous.prompt.trim(), model: previous.model, sessionView: 'general', ...(previous.chatId ? { chatId: previous.chatId } : {}) } : null
}

export function rememberPhoneSessionCreate(ownerId: string, deviceId: string, request: SessionpageSessionCreateRequest, storage: StorageLike = window.localStorage): void {
  const existing = readPhoneSessionCreate(ownerId, deviceId, storage)
  if (existing && JSON.stringify(existing) !== JSON.stringify(request)) throw new Error(taskFlowText('errors.createPending'))
  storage.setItem(key(ownerId, deviceId), JSON.stringify(request))
}

export function forgetPhoneSessionCreate(ownerId: string, deviceId: string, request: SessionpageSessionCreateRequest, storage: StorageLike = window.localStorage): void {
  const existing = readPhoneSessionCreate(ownerId, deviceId, storage)
  if (existing?.clientRequestId !== request.clientRequestId) throw new Error(taskFlowText('errors.createRecordChanged'))
  storage.removeItem(key(ownerId, deviceId))
  const previous = readPhoneAgentCreateAttempt(ownerId, deviceId, storage)
  if (previous && previous.id === request.clientRequestId) forgetPhoneAgentCreateAttempt(previous, storage)
}
