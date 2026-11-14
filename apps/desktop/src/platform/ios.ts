import { schedulePhoneNotification } from './phoneNotificationOutlet'
import { LocalNotifications } from '@capacitor/local-notifications'
import { Capacitor, registerPlugin } from '@capacitor/core'
import type { IOSOwnerBinding } from '../mobile/ios-runtime/iosOwnerClient'
import { App } from '@capacitor/app'
import { Clipboard } from '@capacitor/clipboard'
import type { AppPlatform } from './types'
import { createUnsupportedPlatform } from './unsupported'
import { rendererLogger } from '../lib/log'
import { iosCalendarPermissionsAvailable } from '../mobile/ios-calendar/iosCalendarPermissionsAvailability'

const push = registerPlugin<{
  requestAuthorization(input: { expectedBinding: IOSOwnerBinding }): Promise<{ visibleAlertsAllowed: boolean }>
}>('GuguPushNotifications')
const base = createUnsupportedPlatform('capacitor', 'iOS')
const lifecycleError = (error: unknown) => rendererLogger('ios/lifecycle').error({ error }, 'Cannot observe application lifecycle')

/** Foreground client only. Missing Android plugins never become advertised iOS capabilities. */
export const iosPlatform: AppPlatform = {
  ...base,
  capabilities: { ...base.capabilities, appVersion: true, clipboard: true, get notifications() { return Capacitor.isPluginAvailable('GuguPushNotifications') },
    get calendarSettings() { return iosCalendarPermissionsAvailable() },
  },
  get systemPermissions() { return Capacitor.isPluginAvailable('GuguPushNotifications') ? ['notifications'] as const : [] },
  async checkSystemPermission(permission) {
    if (permission !== 'notifications') return 'unreadable'
    const value = (await LocalNotifications.checkPermissions()).display
    return value === 'granted' ? 'granted' : value === 'prompt' || value === 'prompt-with-rationale' ? 'prompt' : 'blocked'
  },
  async requestSystemPermission(permission) {
    if (permission !== 'notifications') return 'unreadable'
    const { getIOSOwnerPublicationSnapshot } = await import('../mobile/ios-runtime/startIOSOwnerPublication')
    const owner = getIOSOwnerPublicationSnapshot()
    if (owner.status !== 'ready' || !owner.binding) throw new Error('Current native owner is unavailable')
    const result = await push.requestAuthorization({ expectedBinding: owner.binding })
    window.dispatchEvent(new Event('gugu:ios-push-permission'))
    return result.visibleAlertsAllowed ? 'granted' : 'blocked'
  },
  async showNotification(payload) {
    if ((await LocalNotifications.checkPermissions()).display !== 'granted') {
      return { success: false, displayed: false, error: 'NOTIFICATIONS_NOT_GRANTED' }
    }
    // Background alerts belong to APNs; a briefly live WebView must not add a duplicate.
    if (!(await App.getState()).isActive) return { success: false, displayed: false, error: 'APP_NOT_ACTIVE' }
    return schedulePhoneNotification(payload, { sound: payload.silent ? undefined : 'default' })
  },
  subscribeNotificationClicks(listener) {
    let active = true
    const handle = LocalNotifications.addListener('localNotificationActionPerformed', (event) => {
      if (active && event.actionId === 'tap') listener({ chatId: typeof event.notification.extra?.chatId === 'string' ? event.notification.extra.chatId : null })
    })
    return () => { active = false; void handle.then(value => value.remove()).catch(lifecycleError) }
  },
  getAppVersion: async () => (await App.getInfo()).version,
  writeClipboardText: async (string) => { await Clipboard.write({ string }) },
  subscribeAppForeground(listener, onError) {
    let active = true
    let remove: (() => Promise<void>) | undefined
    void App.addListener('resume', () => { if (active) listener() }).then((handle) => {
      if (active) remove = () => handle.remove()
      else void handle.remove().catch(onError)
    }, onError)
    return () => {
      active = false
      if (remove) void remove().catch(onError)
    }
  },
  subscribeAppActive(listener) {
    let active = true
    let changed = false
    let remove: (() => Promise<void>) | undefined
    void App.addListener('appStateChange', (state) => {
      changed = true
      if (active) listener(state.isActive)
    }).then((handle) => {
      if (active) remove = () => handle.remove()
      else void handle.remove().catch(lifecycleError)
    }, lifecycleError)
    // Do not let a delayed initial read overwrite a newer lifecycle event.
    void App.getState().then((state) => { if (active && !changed) listener(state.isActive) }, lifecycleError)
    return () => {
      active = false
      if (remove) void remove().catch(lifecycleError)
    }
  },
}
