import type { IOSOwnerBinding } from '../ios-runtime/iosOwnerClient'
import { IOSAgentError, type IOSAgentClient, type IOSHostChannel } from './iosAgentClient'

export interface IOSNotificationsValue { enabled: boolean; sound: boolean }
export interface IOSNotificationsMeta {
  value: IOSNotificationsValue
  defaults: IOSNotificationsValue
  overrides: IOSNotificationsValue
}
function valueReply(value: unknown): IOSNotificationsValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const fields = value as Record<string, unknown>
  if (Object.keys(fields).length !== 2 || typeof fields.enabled !== 'boolean' || typeof fields.sound !== 'boolean') throw invalid()
  return { enabled: fields.enabled, sound: fields.sound }
}
function metaReply(value: unknown): IOSNotificationsMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid()
  const fields = value as Record<string, unknown>
  return { value: valueReply(fields.value), defaults: valueReply(fields.defaults), overrides: valueReply(fields.overrides) }
}
const invalid = () => new IOSAgentError('settings_unknown', '尚未读到已保存的本机任务通知设置。')

/** Only the local phone's named preference. No generic settings/remote fallback. */
export class IOSNotificationsSettings {
  constructor(private readonly client: IOSAgentClient, private readonly binding: IOSOwnerBinding,
    private readonly requireCurrent: () => void, private readonly readId: () => string = () => crypto.randomUUID()) {}
  private async invoke(channel: IOSHostChannel, args: readonly unknown[], id: string): Promise<unknown> {
    this.requireCurrent()
    const reply = await this.client.call<unknown>(this.binding, id, channel, args)
    this.requireCurrent()
    if ('error' in reply) throw new IOSAgentError(reply.error.code, reply.error.message)
    return reply.result
  }
  async get(): Promise<IOSNotificationsValue> {
    return valueReply(await this.invoke('appSettings.get', ['notifications'], this.readId()))
  }
  async getWithMeta(): Promise<IOSNotificationsMeta> {
    return metaReply(await this.invoke('appSettings.getWithMeta', ['notifications'], this.readId()))
  }
  async update(input: IOSNotificationsValue, originalId: string): Promise<IOSNotificationsMeta> {
    const value = valueReply(input)
    const result = await this.invoke('appSettings.update', ['notifications', value], originalId)
    if (result !== null) throw invalid()
    const persisted = await this.getWithMeta()
    if (persisted.value.enabled !== value.enabled || persisted.value.sound !== value.sound) throw invalid()
    return persisted
  }
}
