import { Capacitor, registerPlugin } from '@capacitor/core'
import { platform } from '@/platform'
import { readNotificationSettings, subscribeNotificationSettings } from '@/lib/notificationSettings'
import { rendererLogger } from '@/lib/log'
import { UI_EVENTS } from '@/lib/uiEvents'
import { chatDb } from '@/lib/supabase'
import { getIOSOwnerPublicationSnapshot, subscribeIOSOwnerPublication } from '../ios-runtime/startIOSOwnerPublication'
import { iosHostRuntime } from '../ios-host/iosHostRuntime'
import type { IOSOwnerBinding } from '../ios-runtime/iosOwnerClient'

const native = registerPlugin<{
  suspend(): Promise<void>
  configure(input: { expectedBinding: IOSOwnerBinding; chatEnabled: boolean; taskEnabled: boolean; chatSoundEnabled: boolean; taskSoundEnabled: boolean }): Promise<void>
  status(input: { expectedBinding: IOSOwnerBinding }): Promise<{ visibleAlertsAllowed: boolean }>
  register(input: { expectedBinding: IOSOwnerBinding }): Promise<unknown>
  addListener(event: 'reconcile' | 'tokenChanged', listener: (hint: { ownerId: string; kind: string; chatId?: string }) => void): Promise<{ remove(): Promise<void> }>
}>('GuguPushNotifications')
const log = rendererLogger('ios/push')

/** No auth ownership or host start: absent local task preferences stay unavailable. */
export function startIOSPush(): () => void {
  if (Capacitor.getPlatform() !== 'ios' || !Capacitor.isPluginAvailable('GuguPushNotifications')) return () => {}
  let active = true
  let epoch = 0
  let signature = ''
  let flight = Promise.resolve()
  const wake = () => window.dispatchEvent(new Event('gugu:ios-push-reconcile'))
  const synchronize = (force = false) => {
    const owner = getIOSOwnerPublicationSnapshot()
    const host = iosHostRuntime.getSnapshot()
    const chat = readNotificationSettings()
    const task = host.settings.status === 'ready' ? host.settings.meta?.value : null
    const binding = owner.status === 'ready' ? owner.binding : null
    const key = JSON.stringify([binding, task, chat, owner.status])
    if (!force && key === signature) return
    signature = key
    const current = ++epoch
    if (!binding || !task || host.binding?.ownerId !== binding.ownerId || host.binding?.installationId !== binding.installationId) {
      void native.suspend().catch(() => log.error({}, 'Cannot withdraw notification authority'))
      return
    }
    const valid = () => active && current === epoch && getIOSOwnerPublicationSnapshot().status === 'ready'
      && getIOSOwnerPublicationSnapshot().binding?.ownerId === binding.ownerId
    flight = flight.catch(() => undefined).then(async () => {
      if (!valid()) return
      await native.configure({ expectedBinding: binding, chatEnabled: chat.chatMessages, chatSoundEnabled: chat.sound,
        taskEnabled: task.enabled, taskSoundEnabled: task.sound })
      if (!valid()) return
      const status = await native.status({ expectedBinding: binding })
      if (valid() && status.visibleAlertsAllowed) await native.register({ expectedBinding: binding })
    }).catch(() => { if (valid()) log.error({}, 'Notification registration is unavailable; retry on foreground') })
  }
  const stops = [subscribeIOSOwnerPublication(() => synchronize()), iosHostRuntime.subscribe(() => synchronize()),
    subscribeNotificationSettings(() => synchronize()), platform.subscribeAppForeground(() => { wake(); synchronize(true) },
      () => log.error({}, 'Cannot observe notification foreground recovery'))]
  const listener = native.addListener('reconcile', (hint) => {
    const owner = getIOSOwnerPublicationSnapshot()
    if (!active || owner.status !== 'ready' || owner.binding?.ownerId !== hint.ownerId) return
    wake()
    if (hint.kind !== 'opened' || !hint.chatId) return
    const current = epoch
    // Canonical membership/RLS read precedes the normal application's route.
    void Promise.resolve(chatDb.from('chats').select('id').eq('id', hint.chatId).maybeSingle()).then(({ data, error }) => {
      if (!error && data && active && epoch === current && getIOSOwnerPublicationSnapshot().binding?.ownerId === hint.ownerId) {
        window.dispatchEvent(new CustomEvent(UI_EVENTS.notificationClicked, { detail: { chatId: data.id } }))
      }
    }).catch(() => log.error({}, 'Cannot reconcile notification destination'))
  }).catch(() => { log.error({}, 'Cannot observe notification reconciliation'); return null })
  const tokenListener = native.addListener('tokenChanged', () => synchronize(true)).catch(() => { log.error({}, 'Cannot observe APNs token rotation'); return null })
  stops.push(() => { void tokenListener.then(handle => handle?.remove()).catch(() => undefined) })
  const permissionChanged = () => synchronize(true)
  window.addEventListener('gugu:ios-push-permission', permissionChanged)
  stops.push(() => window.removeEventListener('gugu:ios-push-permission', permissionChanged))
  synchronize()
  wake()
  return () => { active = false; ++epoch; stops.forEach(stop => stop()); void listener.then(handle => handle?.remove()).catch(() => undefined) }
}
