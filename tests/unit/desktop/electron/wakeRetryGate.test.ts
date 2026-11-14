import { describe, expect, it, vi } from 'vitest'

const warn = vi.hoisted(() => vi.fn())
vi.mock('../../../../apps/desktop/electron/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/electron/lib/logger')>()
  return {
    ...actual,
    createLogger: (scope: string) => scope === 'sessionpage/deliver'
      ? { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() }
      : actual.createLogger(scope),
  }
})
import {
  SessionWakeError,
  SessionpageLocalDeliveryRouter,
  WAKE_RETRY_FIRST_MS,
  WAKE_RETRY_MAX_MS,
} from '../../../../apps/desktop/electron/sessionpage/session-injection'

// Every delivery path (due schedules, inbox, outbox, session-direct) retries on its own cadence and each retry asks the
// one wake entry. A wake that cannot succeed must not start the engine again on every ask.
const SESSION = 'wake-gate-session'

function rig(options: { upgradeRequired?: boolean } = {}) {
  let clock = 1_000_000
  let fail = true
  let said = 'claude tui requires harness runtime 2.1.69 or newer; found 1.8.3'
  const wakeSession = vi.fn(async () => {
    if (fail) throw new Error(said)
  })
  const router = new SessionpageLocalDeliveryRouter([], {
    wakeSession,
    runtimeUpgradeRequired: () => options.upgradeRequired === true,
    now: () => clock,
  })
  return {
    router,
    wakeSession,
    advance: (ms: number) => { clock += ms },
    heal: () => { fail = false },
    say: (next: string) => { said = next },
    wake: () => router.wakeSession(SESSION),
  }
}

describe('wake gate', () => {
  it('a version below the floor starts the engine once, then waits for the session to go live', async () => {
    const r = rig({ upgradeRequired: true })
    await expect(r.wake()).rejects.toThrow(/found 1\.8\.3.*Not retried until this session is opened again/)
    for (let minute = 1; minute <= 120; minute++) {
      r.advance(60_000)
      await expect(r.wake()).rejects.toBeInstanceOf(SessionWakeError)
    }
    expect(r.wakeSession).toHaveBeenCalledTimes(1)

    // The person upgrades and opens the session: it goes live, the gate is lifted.
    r.heal()
    r.router.sessionLive(SESSION)
    await expect(r.wake()).resolves.toBe('reopened')
    expect(r.wakeSession).toHaveBeenCalledTimes(2)
  })

  it('a transient failure backs off exponentially up to the cap', async () => {
    const r = rig()
    const attemptsAt: number[] = []
    let elapsed = 0
    for (let second = 0; second <= 4 * 60 * 60; second += 10) {
      const before = r.wakeSession.mock.calls.length
      await r.wake().catch(() => undefined)
      if (r.wakeSession.mock.calls.length > before) attemptsAt.push(elapsed)
      r.advance(10_000)
      elapsed += 10_000
    }
    const gaps = attemptsAt.slice(1).map((at, i) => at - attemptsAt[i]!)
    expect(gaps.slice(0, 6)).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 960_000])
    expect(gaps.slice(6).every((gap) => gap === WAKE_RETRY_MAX_MS)).toBe(true)
    expect(gaps[0]).toBe(WAKE_RETRY_FIRST_MS)

    r.heal()
    r.advance(WAKE_RETRY_MAX_MS)
    await expect(r.wake()).resolves.toBe('reopened')
    // Success forgets the failures: a later failure starts the ladder from the first step again.
    expect(r.wakeSession).toHaveBeenCalledTimes(attemptsAt.length + 1)
  })

  it('callers inside the window get the remembered reason without a new start', async () => {
    const r = rig()
    const first = await r.wake().catch((error: Error) => error)
    r.advance(WAKE_RETRY_FIRST_MS - 1)
    const second = await r.wake().catch((error: Error) => error)
    expect(second).toBe(first)
    expect(r.wakeSession).toHaveBeenCalledTimes(1)
  })

  it('concurrent wakes for one session share one start', async () => {
    let release!: () => void
    const wakeSession = vi.fn(() => new Promise<void>((resolve) => { release = resolve }))
    const router = new SessionpageLocalDeliveryRouter([], { wakeSession })
    const asks = Array.from({ length: 21 }, () => router.wakeSession(SESSION))
    await vi.waitFor(() => expect(wakeSession).toHaveBeenCalledTimes(1))
    release()
    await expect(Promise.all(asks)).resolves.toEqual(Array(21).fill('reopened'))
    expect(wakeSession).toHaveBeenCalledTimes(1)
  })

  it('logs a remembered failure once per reason: silent while it repeats, again when the reason changes', async () => {
    warn.mockClear()
    const r = rig()
    // The real attempt: no owner has this session registered, so injection refuses and the wake runs.
    const attempt = async () => (await r.router.tryInjectSessionMessage(SESSION, { id: 'm1', text: 't' })) === false ? 'not-live' as const : true
    const deliver = () => r.router.injectWithWake(SESSION, attempt).catch(() => undefined)
    const logged = () => warn.mock.calls.filter(([, msg]) => msg === 'session-direct target not live after wake').length
    await deliver()
    expect(logged()).toBe(1)
    // Every minute for two hours: replays inside the window and real retries with the same reason stay silent.
    for (let minute = 1; minute <= 120; minute++) {
      r.advance(60_000)
      await deliver()
    }
    expect(r.wakeSession.mock.calls.length).toBeGreaterThan(1)
    expect(logged()).toBe(1)

    r.say('provider resume failed')
    r.advance(WAKE_RETRY_MAX_MS)
    await deliver()
    expect(logged()).toBe(2)
    // The "not registered" line belongs to the same cause: only the very first attempt, before any wake failed, writes it.
    expect(warn.mock.calls.filter(([, msg]) => String(msg).includes('无登记'))).toHaveLength(1)
  })
})
