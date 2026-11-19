import { historyTime } from '@gugu/core/shared/conversationHistoryTime'
import { directoryDevices, directoryRows, liveDeviceSessions, subscribeDeviceSessions } from '../session/shared/remote-sessions/session-directory'
import { readSelfIdentityBridge } from './selfIdentityBridge'

type State = { floors: Map<string, Map<string, string>>; bindings: Map<string, Map<string, string>>; listeners: Set<() => void> }
const KEY = '__GUGU_NATIVE_CONVERSATION_HISTORY_CLEAR__'
function state(): State {
  const target = window as unknown as Record<string, State>
  const current = target[KEY] ??= { floors: new Map(), bindings: new Map(), listeners: new Set() }
  current.bindings ??= new Map()
  return current
}
export function recordNativeConversationHistoryClear(accountId: string, chatId: string, at?: string | null): void {
  if (!at) return
  const owner = state(), floors = owner.floors.get(accountId) ?? new Map<string, string>()
  const old = floors.get(chatId)
  if (old && historyTime(old) >= historyTime(at)) return
  floors.set(chatId, at); owner.floors.set(accountId, floors)
  for (const listener of owner.listeners) listener()
}
export function subscribeNativeConversationHistoryClear(uri: string | undefined, update: (floor: string | null) => void): () => void {
  const owner = state()
  const changed = () => {
    const self = readSelfIdentityBridge()?.getSnapshot()?.userId
    const sessionId = uri?.replace(/^session:/, '')
    const row = directoryRows(directoryDevices(), liveDeviceSessions()).find(row => row.session.conversationId === sessionId)
    if (self && sessionId && row?.session.chatId) {
      const bindings = owner.bindings.get(self) ?? new Map<string, string>()
      bindings.set(sessionId, row.session.chatId); owner.bindings.set(self, bindings)
    }
    const chatId = self && sessionId ? owner.bindings.get(self)?.get(sessionId) : undefined
    update(self && chatId ? owner.floors.get(self)?.get(chatId) ?? null : null)
  }
  owner.listeners.add(changed)
  const stopDirectory = subscribeDeviceSessions(changed), stopSelf = readSelfIdentityBridge()?.subscribe(changed)
  changed()
  return () => { owner.listeners.delete(changed); stopDirectory(); stopSelf?.() }
}
