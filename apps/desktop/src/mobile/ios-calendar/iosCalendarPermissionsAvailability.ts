import { Capacitor } from '@capacitor/core'

/** Shared by the iOS-only page and A's existing navigation filter. No permission request. */
export function iosCalendarPermissionsAvailable(): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === 'ios'
    && Capacitor.isPluginAvailable('GuguCalendarPermissions') && Capacitor.isPluginAvailable('GuguIOSOwner')
}
