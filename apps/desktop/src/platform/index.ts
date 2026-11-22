import { Capacitor } from '@capacitor/core'
import { electronPlatform } from './electron'
import { capacitorPlatform } from './capacitor'
import { iosPlatform } from './ios'
import { webPlatform } from './web'

export type { AppPlatform } from './types'
export { PlatformError } from './errors'

// `globalThis.window?.`: this module is imported by every UI primitive that asks for the shell (useMobileShell), and a node
// test imports UI before it puts a JSDOM window in place — there, as on the web, it is the web platform.
const hostPlatform = globalThis.window?.electronAPI
  ? electronPlatform
  : Capacitor.isNativePlatform()
    ? Capacitor.getPlatform() === 'ios' ? iosPlatform : capacitorPlatform
    : webPlatform

export const platform = hostPlatform
