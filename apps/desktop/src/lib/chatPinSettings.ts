import { readOwnSettings, updateOwnSettings } from './ownSettings'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from './realtimeChannel'

export type ChatPinSettings = { topicIds: string[] }
const scopeOf = (chatId: string) => `chat:${chatId}` as const

function idsOf(config: Record<string, unknown>): string[] {
  const value = config.pinnedTopicIds
  if (value === undefined) return []
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || !id)) {
    throw new Error('Invalid pinned topic preferences')
  }
  return [...new Set(value as string[])]
}

function pinsOf(config: Record<string, unknown>): ChatPinSettings {
  return { topicIds: idsOf(config) }
}

export async function readChatPinSettings(userId: string, chatId: string): Promise<ChatPinSettings> {
  return pinsOf(await readOwnSettings(userId, scopeOf(chatId)))
}

export async function setChatPinPreference(userId: string, chatId: string, id: string, pinned: boolean): Promise<ChatPinSettings> {
  const saved = await updateOwnSettings(userId, scopeOf(chatId), (config) => {
    const before = idsOf(config)
    const ids = pinned ? before.includes(id) ? before : [...before, id] : before.filter((value) => value !== id)
    return { ...config, pinnedTopicIds: ids }
  })
  return pinsOf(saved.config)
}

/** One account channel and reconnecting; a return to the app reads the pins again by their model (`refreshOnFocus`). */
export function watchChatPinSettings(userId: string, chatId: string, read: () => void): () => void {
  // Each of these says the row may have changed elsewhere: read it again.
  const refresh = () => { read() }
  const handle = subscribePrivateUserEventBus(userId, 'setting_changed', (payload) => {
    const setting = (payload as { setting?: { user_id?: string; scope?: string } } | null)?.setting
    if (setting?.user_id === userId && setting.scope === scopeOf(chatId)) refresh()
  }, { onSubscribed: refresh })
  window.addEventListener('online', refresh)
  return () => {
    unsubscribePrivateUserEventBus(handle)
    window.removeEventListener('online', refresh)
  }
}
