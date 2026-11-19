import type { VaultSync } from './sync'
interface VaultPullHost { presence(): 'active' | 'idle' | 'locked'; notify(title: string, body: string): void }

/** Polls the head revision every 5 seconds (3 while a code is on screen) and pulls when something was written, and every
 * minute regardless. Every step of joining writes, so both devices see the other's step at the next poll. Failures wait
 * for the next round; nothing is shown.
 * A device asking to join is opened on the machine the person is at: at once where they are active, after a pause where
 * the screen is merely unlocked, never where it is locked; an active machine also takes over a request opened elsewhere. */
export function createVaultPulling(sync: Pick<VaultSync, 'view' | 'poll' | 'refresh' | 'challenge'>, host: VaultPullHost, signal: AbortSignal) {
  let timer: ReturnType<typeof setTimeout> | undefined, last = 0, stopped = false, forced = false
  let flight: Promise<void> | undefined
  const seen = new Map<string, number>()
  const urgent = () => {
    const view = sync.view()
    return view.state === 'joining' && !!view.code || view.state === 'ready' && view.requests.some(request => request.stage === 'waiting' || request.stage === 'compare')
  }
  const claim = async () => {
    const view = sync.view()
    if (view.state !== 'ready') { seen.clear(); return }
    for (const id of seen.keys()) if (!view.requests.some(request => request.deviceId === id)) seen.delete(id)
    const presence = host.presence()
    for (const request of view.requests) {
      if (!seen.has(request.deviceId)) { seen.set(request.deviceId, Date.now()); host.notify(`「${request.label || '新设备'}」想用你的密码`, '打开咕咕，核对两台设备上的数字。') }
      const waited = Date.now() - seen.get(request.deviceId)! > 8_000
      if (presence !== 'locked' && request.stage === 'new' && (presence === 'active' || waited) || presence === 'active' && request.stage === 'elsewhere')
        await sync.challenge(request.deviceId).catch(() => {})
    }
  }
  const run = async () => {
    if (signal.aborted || stopped) return
    try {
      const full = forced || Date.now() - last > 60_000
      forced = false
      if (full || await sync.poll()) { last = Date.now(); await sync.refresh() }
      // Every round, not only after a pull: a request waits out its pause on a merely unlocked machine without any write.
      await claim()
    } catch { /* offline or not signed in: the next round retries */ }
    finally { schedule(urgent() ? 3_000 : 5_000) }
  }
  const schedule = (delay: number) => {
    if (signal.aborted || stopped) return
    clearTimeout(timer); timer = setTimeout(() => {
      if (signal.aborted || stopped || flight) return
      const pending = Promise.resolve().then(run)
      flight = pending
      const settled = () => { if (flight === pending) flight = undefined }
      void pending.then(settled, settled)
    }, delay); timer.unref?.()
  }
  signal.addEventListener('abort', () => { stopped = true; clearTimeout(timer) }, { once: true })
  forced = true; schedule(0)
  return {
    /** The settings page or a prompt asked: pull soon, at most every 10 seconds. */
    soon: () => { if (Date.now() - last > 10_000) { forced = true; schedule(0) } },
    /** A local save: the first one creates the vault, so pull now. */
    now: () => { forced = true; schedule(0) },
    /** Abort the account first, then wait for any in-flight sync file writes. */
    stop: async () => { stopped = true; clearTimeout(timer); await flight },
  }
}
