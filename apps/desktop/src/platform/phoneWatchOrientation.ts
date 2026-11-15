import { Capacitor, registerPlugin } from '@capacitor/core'

export interface PhoneWatchOrientationBridge {
  set(options: { id: string; orientation: 'portrait' | 'landscape' }): Promise<void>
  release(options: { id: string }): Promise<unknown>
}

const native = registerPlugin<PhoneWatchOrientationBridge>('GuguWatchOrientation')
let changes: Promise<unknown> = Promise.resolve()

/** Android's display orientation does not turn into landscape when its keyboard shortens the WebView. */
export function phoneWatchIsLandscape(): boolean {
  return Capacitor.getPlatform() === 'android'
    ? window.screen.orientation.type.startsWith('landscape')
    : matchMedia('(orientation: landscape)').matches
}

/** Keep asynchronous native changes in order when one conversation replaces another. */
function enqueue<T>(change: () => Promise<T>): Promise<T> {
  const result = changes.then(change)
  // Each caller receives its own rejection; a failed change must not block a later release.
  changes = result.then(() => undefined, () => undefined)
  return result
}

export function createPhoneWatchOrientation(bridge: PhoneWatchOrientationBridge = native) {
  const id = crypto.randomUUID()
  let released = false
  let requested = false
  return {
    set(orientation: 'portrait' | 'landscape'): Promise<void> {
      if (released) return Promise.reject(new Error('This viewing window is closed'))
      if (bridge === native && (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('GuguWatchOrientation'))) {
        return Promise.reject(new Error('Screen orientation is unavailable on this device'))
      }
      requested = true
      return enqueue(() => bridge.set({ id, orientation }))
    },
    release(): Promise<void> {
      if (released || !requested) { released = true; return Promise.resolve() }
      released = true
      return enqueue(async () => { await bridge.release({ id }) })
    },
  }
}
