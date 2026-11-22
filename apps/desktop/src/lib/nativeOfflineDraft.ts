import { state } from './outbox/kinds/sessionInput'
import { clearViewState, readViewState, writeViewState, type ViewPanel } from './viewStateTable'
import { i18n } from '@/i18n/runtime'

// A task session's unsent input, per account, device and session: in the view-state table (panel `draft`, the same caps as
// a chat's), from the first frame.
const listeners = new Set<() => void>()
export function subscribeNativeOfflineDraft(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
const draftOf = (accountId: string, deviceId: string, sessionId: string): ViewPanel =>
  ({ conversation: `task:${deviceId}/${sessionId}`, panel: 'draft', account: accountId })
const panel = (deviceId: string | null, sessionId: string) => {
  const own = state()
  return own.valid() && own.accountId ? draftOf(own.accountId, deviceId ?? 'local', sessionId) : null
}

// Kept in localStorage before the table (`gugu.native-offline-draft:<account>/<device>/<session>`): moved over once, when
// this module loads, then removed there.
const LEGACY_PREFIX = 'gugu.native-offline-draft:'
if (typeof localStorage !== 'undefined') {
  const keys = Array.from({ length: localStorage.length }, (_, i) => localStorage.key(i)).filter((key): key is string => !!key?.startsWith(LEGACY_PREFIX))
  for (const key of keys) {
    const [accountId, deviceId, ...session] = key.slice(LEGACY_PREFIX.length).split('/')
    const text = localStorage.getItem(key)
    if (accountId && deviceId && session.length && text) writeViewState(draftOf(accountId, deviceId, session.join('/')), { text })
  }
  // Once all are in, every old key goes: the table holds what its caps allow.
  for (const key of keys) localStorage.removeItem(key)
}

export function readNativeOfflineDraft(deviceId: string | null, sessionId: string): string {
  const id = panel(deviceId, sessionId)
  return id ? readViewState<{ text: string }>(id).text ?? '' : ''
}
export function writeNativeOfflineDraft(deviceId: string | null, sessionId: string, text: string): void {
  const id = panel(deviceId, sessionId)
  if (!id) throw new Error(i18n.t('composer.sessionInput.accountNotReady', { ns: 'messaging' }))
  if (text) writeViewState(id, { text })
  else clearViewState(id)
  for (const listener of [...listeners]) listener()
}
