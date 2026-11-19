import { Capacitor, registerPlugin } from '@capacitor/core'
import { createGuguSupabaseClient } from '@gugu/core/cloud/supabase'
import { platform } from '@/platform'
import { readDevicePreferences, subscribeDevicePreferences } from '@/lib/devicePreferences'
import { getRendererSession, observeRendererSession } from '@/lib/sessionPublication'
import { authBoundedFetch } from '@/lib/authBoundedFetch'
import { rendererLogger } from '@/lib/log'
import { UI_EVENTS } from '@/lib/uiEvents'
import { AndroidPushSync, type PushBinding, type PushScope, type PushReceipt } from './androidPushSync'
import { cachedPhoneInstallation } from '../phone-device/phoneDeviceSettings'
import { setAndroidPushConfirmed } from './androidPushState'

type OwnerRequest = { ownerId: string; cachedId: string | null; cachedBinding: string | null }
type TokenBinding = PushBinding & { token: string }
const native = registerPlugin<{
  status(input: OwnerRequest): Promise<PushBinding>
  register(input: OwnerRequest): Promise<TokenBinding>
  revoke(input: OwnerRequest): Promise<void>
  addListener(event: 'tokenChanged' | 'opened', listener: (data: Record<string, unknown>) => void): Promise<{ remove(): Promise<void> }>
}>('GuguAndroidPush')
const available = () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('GuguAndroidPush')
const log = rendererLogger('android/push')
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
function scopeNow(): PushScope | null {
  const session = getRendererSession()
  if (!session) return null
  try {
    const claims = JSON.parse(atob(session.access_token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as { session_id?: string }
    return typeof claims.session_id === 'string' && UUID.test(claims.session_id)
      ? { ownerId: session.user.id, sessionId: claims.session_id } : null
  } catch { return null }
}
function scopedClient(scope: PushScope, schema: 'identity' | 'chat') {
  const current = scopeNow(); const token = getRendererSession()?.access_token
  if (!token || current?.ownerId !== scope.ownerId || current.sessionId !== scope.sessionId) throw new Error('Android push login changed')
  return createGuguSupabaseClient({ schema, accessToken: async () => token, fetch: authBoundedFetch })
}
function binding(value: PushBinding, scope: PushScope): PushBinding {
  if (value.ownerId !== scope.ownerId || !UUID.test(value.installationId)
    || value.deviceId !== `phone-${value.installationId}-${scope.ownerId}`
    || !['app.gugu.chat', 'app.gugu.chat.beta'].includes(value.topic) || value.environment !== 'production'
    || (value.provider !== null && value.provider !== 'fcm') || typeof value.allowed !== 'boolean') throw new Error('Invalid Android push binding')
  return value
}
function nativeInput(scope: PushScope): OwnerRequest {
  const cached = cachedPhoneInstallation()
  return { ownerId: scope.ownerId, cachedId: cached.cachedInstallId, cachedBinding: cached.cachedBinding }
}
const receiptKey = (scope: PushScope, endpoint: PushBinding) => `gugu.androidPush.v1:${endpoint.installationId}:${scope.ownerId}:${scope.sessionId}`
const runtime = new AndroidPushSync({
  restore(scope, endpoint) {
    const raw = localStorage.getItem(receiptKey(scope, endpoint))
    if (!raw) return null
    const value = JSON.parse(raw) as PushReceipt
    if (!UUID.test(value.registration_id) || !UUID.test(value.generation)) throw new Error('Invalid retained push receipt')
    return value
  },
  status: async scope => binding(await native.status(nativeInput(scope)), scope),
  register: async scope => {
    const token = await native.register(nativeInput(scope))
    binding({ ...token, allowed: true }, scope)
    if (typeof token.token !== 'string' || !/^[!-~]{1,4096}$/.test(token.token)) throw new Error('Invalid Android push token')
    return { ...token, allowed: true }
  },
  async save(scope, endpoint, prefs) {
    const { data, error } = await scopedClient(scope, 'identity').rpc('mobile_push_register', {
      p_installation_id: endpoint.installationId, p_device_id: endpoint.deviceId, p_provider: endpoint.provider,
      p_token: endpoint.token, p_environment: endpoint.environment, p_topic: endpoint.topic,
      p_chat_enabled: prefs.chatMessages, p_task_enabled: prefs.taskEnabled, p_chat_sound_enabled: prefs.chatSound, p_task_sound_enabled: prefs.taskSound,
    })
    if (error || !data || !UUID.test(data.registration_id) || !UUID.test(data.generation)) throw new Error('Android push registration was not confirmed')
    const receipt = { registration_id: data.registration_id, generation: data.generation } as PushReceipt
    localStorage.setItem(receiptKey(scope, endpoint), JSON.stringify(receipt))
    return receipt
  },
  async revoke(scope, endpoint, receipt) {
    const { data, error } = await scopedClient(scope, 'identity').rpc('mobile_push_revoke', {
      p_installation_id: endpoint.installationId, p_registration_id: receipt.registration_id, p_generation: receipt.generation,
    })
    if (error) throw new Error('Android push revocation unavailable')
    if (data === true) localStorage.removeItem(receiptKey(scope, endpoint))
    return data === true
  },
  async close(scope, endpoint) {
    const { data, error } = await scopedClient(scope, 'identity').rpc('mobile_push_close_installation', {
      p_installation_id: endpoint.installationId, p_device_id: endpoint.deviceId, p_original_session_id: scope.sessionId,
    })
    if (error || data?.v !== 1 || data.closed !== true || data.owner_id !== scope.ownerId || data.session_id !== scope.sessionId
      || data.installation_id !== endpoint.installationId || data.device_id !== endpoint.deviceId
      || !(data.evidence === 'installation_fenced' && UUID.test(data.fence_id)
        || data.evidence === 'session_absent' && data.fence_id === null)) throw new Error('Android push cleanup was not confirmed')
    localStorage.removeItem(receiptKey(scope, endpoint))
  },
  revokeNative: scope => native.revoke(nativeInput(scope)),
  authority: setAndroidPushConfirmed,
})

/** Called before credentials are cleared; failures leave sign-out pending. */
export async function prepareAndroidPushSignOut(expectedOwner?: string): Promise<void> {
  if (!available()) return
  const scope = scopeNow()
  if (!scope || expectedOwner && scope.ownerId !== expectedOwner) throw new Error('Current Android login required for push cleanup')
  await runtime.retire(scope)
}
export function startAndroidPush(): () => void {
  if (!available()) return () => {}
  let active = true
  let signature = ''
  let pendingTap: Record<string, unknown> | null = null
  const reconcileTap = () => {
    const scope = scopeNow(); const hint = pendingTap
    if (!active || !scope || !hint) return
    const saved = runtime.bindingForTap(scope)
    if (!saved) return
    pendingTap = null
    if (hint.v !== '1' || hint.ownerId !== scope.ownerId || hint.installationId !== saved.binding.installationId
      || hint.registrationId !== saved.value.registration_id || hint.generation !== saved.value.generation
      || !['chat_message', 'task_attention'].includes(String(hint.kind)) || typeof hint.chatId !== 'string') return
    void Promise.resolve(scopedClient(scope, 'chat').from('chats').select('id').eq('id', hint.chatId).maybeSingle()).then(({ data, error }) => {
      const current = scopeNow()
      if (!error && data && active && current?.ownerId === scope.ownerId && current.sessionId === scope.sessionId)
        window.dispatchEvent(new CustomEvent(UI_EVENTS.notificationClicked, { detail: { chatId: data.id } }))
    }).catch(() => log.error({}, 'Cannot reconcile Android notification destination'))
  }
  const synchronize = (force = false) => {
    const scope = scopeNow(); const chat = readDevicePreferences()
    // Android's existing task watcher is enabled while signed in and its
    // announceAgentWait outlet uses this device's chat sound preference.
    const prefs = { chatMessages: chat.chatMessages, chatSound: chat.chatSound, taskEnabled: true, taskSound: chat.chatSound }
    const next = JSON.stringify([scope, prefs])
    if (!force && next === signature) return
    signature = next
    void runtime.synchronize(scope, prefs).then(reconcileTap).catch(() => log.error({}, 'Android push unavailable; retry on foreground'))
  }
  const token = native.addListener('tokenChanged', () => synchronize(true))
  const opened = native.addListener('opened', hint => { pendingTap = hint; reconcileTap() })
  const stops = [observeRendererSession(() => synchronize()), subscribeDevicePreferences(() => synchronize()),
    platform.subscribeAppForeground(() => synchronize(true), () => log.error({}, 'Cannot observe Android push recovery'))]
  const permission = () => synchronize(true)
  window.addEventListener('gugu:android-notification-permission', permission)
  synchronize()
  void token.catch(() => log.error({}, 'Cannot observe Android push token rotation'))
  void opened.catch(() => log.error({}, 'Cannot observe Android notification taps'))
  return () => {
    active = false; runtime.withdraw(); stops.forEach(stop => stop())
    window.removeEventListener('gugu:android-notification-permission', permission)
    for (const handle of [token, opened]) void handle.then(listener => listener.remove()).catch(() => undefined)
  }
}
