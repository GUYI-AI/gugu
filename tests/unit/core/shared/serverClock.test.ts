import { describe, expect, it } from 'vitest'
import { createServerClock, withServerClock } from '@gugu/core/shared/serverClock'

// The backend's real time in these cases, and how a `Date` header writes it (whole seconds, rounded down).
const SERVER = Date.parse('2026-11-16T12:00:00.400Z')
const header = (at: number) => new Date(at).toUTCString()
const FAST = (4 * 60 + 17) * 60_000 // the reported PC: 4 h 17 min ahead
const SLOW = -4 * 60 * 60_000

/** A device whose clock reads `skew` off the backend's; `at(ms)` = the backend's time after ms of real time. */
function device(skew: number) {
  let real = SERVER
  const clock = createServerClock(() => real + skew)
  return {
    clock,
    advance: (ms: number) => { real += ms },
    /** One request: out now, the backend stamps after `stampAfter` ms, the answer is back after `rtt` ms. */
    answer(rtt: number, stampAfter = rtt / 2) {
      const sentAt = real + skew
      const stamped = real + stampAfter
      real += rtt
      clock.observe(header(stamped), sentAt, real + skew)
    },
    error: () => clock.now() - real,
  }
}

describe('serverClock', () => {
  it('before any answer, the local clock is all there is', () => {
    const d = device(FAST)
    expect(d.error()).toBe(FAST)
  })

  it.each([['fast', FAST], ['slow', SLOW], ['right', 0]])('a %s device clock reads the backend within the Date granularity after one quick answer', (_name, skew) => {
    const d = device(skew)
    d.answer(80)
    expect(Math.abs(d.error())).toBeLessThanOrEqual(600)
  })

  it('narrows with quick answers toward the true offset, and stays there', () => {
    const d = device(FAST)
    for (let i = 0; i < 20; i += 1) { d.answer(60, 30); d.advance(337) }
    expect(Math.abs(d.error())).toBeLessThan(150)
  })

  it('one slow answer (a suspended page, a stalled network) never moves a good reading', () => {
    const d = device(SLOW)
    for (let i = 0; i < 5; i += 1) { d.answer(60); d.advance(250) }
    const before = d.error()
    // In flight 66 minutes, stamped at its very start: its interval is wide and still holds the truth.
    d.answer(66 * 60_000, 10)
    // Its interval holds every earlier one's truth: the reading can only narrow, never be dragged by the 66 minutes.
    expect(Math.abs(d.error() - before)).toBeLessThan(500)
    expect(Math.abs(d.error())).toBeLessThan(600)
  })

  it('a device clock that is set (jumps) is followed from the next answer', () => {
    let real = SERVER
    let skew = FAST
    const clock = createServerClock(() => real + skew)
    const answer = () => { clock.observe(header(real + 40), real + skew, real + 80 + skew); real += 80 }
    answer(); answer()
    expect(Math.abs(clock.now() - real)).toBeLessThan(1_000)
    skew = 0 // the person fixes the clock
    expect(Math.abs(clock.now() - real)).toBeGreaterThan(FAST - 1_000)
    answer()
    expect(Math.abs(clock.now() - real)).toBeLessThan(1_000)
  })

  it('ignores an answer without a usable Date, and one whose local times ran backwards', () => {
    const d = device(FAST)
    d.clock.observe(null, 0, 10)
    d.clock.observe('not a date', 0, 10)
    d.clock.observe(header(SERVER), 10, 0)
    expect(d.error()).toBe(FAST)
  })
})

describe('withServerClock', () => {
  const dated = (date: string | null) => async (_url: string) => new Response('{}', { headers: date ? { date } : {} })

  it('reads the Date of answers from PostgREST, edge functions and GoTrue', async () => {
    for (const path of ['/rest/v1/messages', '/functions/v1/model-access', '/auth/v1/token']) {
      const clock = createServerClock()
      await withServerClock(dated(header(Date.now() + FAST)), clock)(`https://db.test${path}`)
      expect(Math.abs(clock.now() - Date.now() - FAST)).toBeLessThan(1_500)
    }
  })

  it('does not read storage answers: an HTTP cache can replay an old Date', async () => {
    const clock = createServerClock()
    await withServerClock(dated(header(Date.now() - 3_600_000)), clock)('https://db.test/storage/v1/object/sign/x')
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50)
  })

  it('returns the answer itself, and tolerates a fetch double without headers', async () => {
    const clock = createServerClock()
    const answer = { ok: true }
    await expect(withServerClock(async (_url: string) => answer as { headers?: undefined }, clock)('https://db.test/rest/v1/x')).resolves.toBe(answer)
  })
})
