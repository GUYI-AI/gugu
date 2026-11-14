import { Capacitor } from '@capacitor/core'

/** A protocol capability, never permission to use another platform's wire. */
export function nativePhoneAgentHostAvailable(os: 'ios' | 'android'): boolean {
  return Capacitor.isNativePlatform() && Capacitor.getPlatform() === os && Capacitor.isPluginAvailable('GuguAgent')
}
