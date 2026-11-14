import { Capacitor, registerPlugin } from '@capacitor/core'
import type { IOSOwnerBinding } from '../ios-runtime/iosOwnerClient'

export type IOSHostStatus = 'starting' | 'ready' | 'failed' | 'stopped' | 'interrupted'
export interface IOSHostState {
  ownerId: string
  deviceId: string
  status: IOSHostStatus
  ready: boolean
  taskTimeline: boolean
  sessions: readonly Record<string, unknown>[]
  project: { id: string; name: string; path: string } | null
  lastHeartbeatAt: number | null
  error: string | null
  errorCode: string | null
}
export type IOSHostChannel =
  | `appSettings.${'get' | 'getWithMeta' | 'update'}`
  | `sessionTimeline.${'sessionsList' | 'sessionOfAgent' | 'sessionCreateOptions' | 'sessionCreateModels'
    | 'sessionSnapshot' | 'sessionAfter' | 'sessionOlder' | 'sessionToolImage' | 'sessionOptions'
    | 'sessionCreate' | 'sessionSend' | 'sessionRespond' | 'sessionQueue' | 'sessionCancel'
    | 'sessionSetOption' | 'sessionReloadModel' | 'prefetchFiles'}`
  | 'sessions.markSessionSeen'
export type IOSHostReply<T> = { result: T } | { error: { code: string; message: string; admission: 'rejected' | 'uncertain' } }
export interface IOSAgentClient {
  available(): boolean
  configure(binding: IOSOwnerBinding, label?: string): Promise<IOSHostState>
  state(binding: IOSOwnerBinding): Promise<IOSHostState>
  call<T>(binding: IOSOwnerBinding, id: string, channel: IOSHostChannel, args: readonly unknown[]): Promise<IOSHostReply<T>>
  stop(binding: IOSOwnerBinding): Promise<void>
  listen(binding: IOSOwnerBinding, wake: () => void): Promise<() => Promise<void>>
}
export class IOSAgentError extends Error {
  constructor(public readonly code: string, message: string) { super(message); this.name = 'IOSAgentError' }
}
export const iosHostFailure = (cause: unknown): IOSAgentError => cause instanceof IOSAgentError ? cause
  : new IOSAgentError(typeof (cause as { code?: unknown } | null)?.code === 'string' ? (cause as { code: string }).code : 'host_failed', '本机宿主操作未完成，请重试。')
const invalid = () => new IOSAgentError('invalid_native_reply', '未读到有效的本机宿主结果。')
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export function sameIOSBinding(a: IOSOwnerBinding | null, b: IOSOwnerBinding | null): boolean {
  return a === b || !!a && !!b && a.ownerId === b.ownerId && a.deviceId === b.deviceId && a.installationId === b.installationId
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  return value as Record<string, unknown>
}
function stateReply(value: unknown, binding: IOSOwnerBinding): IOSHostState {
  const reply = object(value)
  if (reply.error && typeof reply.error === 'object') throw invalid()
  const statuses: readonly unknown[] = ['starting', 'ready', 'failed', 'stopped', 'interrupted']
  if (reply.ownerId !== binding.ownerId || reply.deviceId !== binding.deviceId || !statuses.includes(reply.status)
    || typeof reply.ready !== 'boolean' || typeof reply.taskTimeline !== 'boolean' || reply.ready && reply.status !== 'ready'
    || reply.taskTimeline && !reply.ready || !Array.isArray(reply.sessions)
    || reply.sessions.some(item => !item || typeof item !== 'object' || Array.isArray(item))
    || reply.error !== null && typeof reply.error !== 'string' || reply.errorCode !== null && typeof reply.errorCode !== 'string') throw invalid()
  const project = reply.project == null ? null : object(reply.project)
  if (project && ['id', 'name', 'path'].some(key => typeof project[key] !== 'string')) throw invalid()
  const heartbeat = reply.lastHeartbeatAt ?? null
  if (heartbeat !== null && (typeof heartbeat !== 'number' || !Number.isFinite(heartbeat))) throw invalid()
  return { ownerId: binding.ownerId, deviceId: binding.deviceId, status: reply.status as IOSHostStatus,
    ready: reply.ready, taskTimeline: reply.taskTimeline, sessions: reply.sessions as Record<string, unknown>[],
    project: project as IOSHostState['project'], lastHeartbeatAt: heartbeat as number | null,
    error: reply.error as string | null, errorCode: reply.errorCode as string | null }
}
const native = registerPlugin<{
  configure(input: { expectedBinding: IOSOwnerBinding; device?: { label: string } }): Promise<unknown>
  hostState(input: { expectedBinding: IOSOwnerBinding }): Promise<unknown>
  hostCall(input: { expectedBinding: IOSOwnerBinding; id: string; channel: IOSHostChannel; args: readonly unknown[] }): Promise<unknown>
  stopHost(input: { expectedBinding: IOSOwnerBinding }): Promise<unknown>
  addListener(name: 'hostState', listener: (event: unknown) => void): Promise<{ remove(): Promise<void> }>
}>('GuguAgent')
function available(): boolean { return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios' && Capacitor.isPluginAvailable('GuguAgent') }
function requireBinding(binding: IOSOwnerBinding): IOSOwnerBinding {
  if (!available()) throw new IOSAgentError('unavailable', '此安装包暂未提供本机宿主。')
  if (!uuid.test(binding.ownerId) || !uuid.test(binding.installationId) || binding.deviceId !== `phone-${binding.installationId}-${binding.ownerId}`) throw invalid()
  return { ownerId: binding.ownerId, deviceId: binding.deviceId, installationId: binding.installationId }
}

/** iOS-only wire. Auth delegation and Android credential configuration are absent. */
export const iosAgentClient: IOSAgentClient = {
  available,
  async configure(input, label) {
    const binding = requireBinding(input)
    if (label !== undefined && (!label.trim() || new TextEncoder().encode(label).length > 256)) throw invalid()
    return stateReply(await native.configure({ expectedBinding: binding, ...(label === undefined ? {} : { device: { label } }) }), binding)
  },
  async state(input) {
    const binding = requireBinding(input)
    return stateReply(await native.hostState({ expectedBinding: binding }), binding)
  },
  async call<T>(input: IOSOwnerBinding, id: string, channel: IOSHostChannel, args: readonly unknown[]) {
    const binding = requireBinding(input)
    if (!uuid.test(id)) throw new IOSAgentError('invalid_args', '请保留原始本机请求标识。')
    const reply = object(await native.hostCall({ expectedBinding: binding, id, channel, args }))
    const hasResult = Object.hasOwn(reply, 'result')
    if (hasResult === Object.hasOwn(reply, 'error')) throw invalid()
    if (hasResult) return { result: reply.result as T }
    const error = object(reply.error)
    if (typeof error.code !== 'string' || typeof error.message !== 'string' || !['rejected', 'uncertain'].includes(error.admission as string)) throw invalid()
    return { error: { code: error.code, message: error.message, admission: error.admission as 'rejected' | 'uncertain' } }
  },
  async stop(input) {
    const binding = requireBinding(input)
    if (Object.keys(object(await native.stopHost({ expectedBinding: binding }))).length !== 0) throw invalid()
  },
  async listen(input, wake) {
    const binding = requireBinding(input)
    const handle = await native.addListener('hostState', event => {
      if (event && typeof event === 'object' && !Array.isArray(event)) {
        const value = event as Record<string, unknown>
        if (value.ownerId === binding.ownerId && value.deviceId === binding.deviceId) wake()
      }
    })
    return () => handle.remove()
  },
}
