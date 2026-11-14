import { platform } from '@/platform'

/** Permission sheets can answer before iOS restores the foreground owner UI. */
export function waitForCalendarAppActive(signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    let unsubscribe: (() => void) | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    const finish = (active: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal.removeEventListener('abort', cancel)
      unsubscribe?.()
      resolve(active)
    }
    const cancel = () => finish(false)
    if (signal.aborted || !platform.subscribeAppActive) { finish(false); return }
    signal.addEventListener('abort', cancel, { once: true })
    // A missing lifecycle signal never turns into assumed foreground access.
    timeout = setTimeout(() => finish(false), 5000)
    try {
      unsubscribe = platform.subscribeAppActive(active => { if (active) finish(true) })
      // Native adapters may report their current state synchronously.
      if (settled) unsubscribe()
    } catch { finish(false) }
  })
}
