import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { acquireStateLock } from '@gugu/core/local/state/fileLocks'

// A waiter's wait is the sum of the critical sections queued ahead of it plus any main-loop stall. On a slow machine that
// legitimately exceeds seconds (Windows ARM: one roster write ~400 ms, main-loop stalls of 3 s+), so a waiter must not be
// failed for waiting; a holder that does not let go is reported from the holder's side.
describe('state lock: waiting in line', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('a waiter queued behind a slow holder gets the lock once the holder releases, however long that took', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const releaseFirst = await acquireStateLock('/state/agents.json.lock', 'agents')
    let second: (() => Promise<void>) | null = null
    let failed: unknown = null
    void acquireStateLock('/state/agents.json.lock', 'agents').then((release) => { second = release }, (error) => { failed = error })

    await vi.advanceTimersByTimeAsync(5_000)
    expect(failed).toBeNull()
    expect(second).toBeNull()
    // The holder that has not let go is the one reported, by name.
    expect(errors.mock.calls.some((args) => args.some((arg) => String(arg).includes('agents lock held for over')))).toBe(true)

    await releaseFirst()
    await vi.advanceTimersByTimeAsync(0)
    expect(failed).toBeNull()
    expect(second).not.toBeNull()
    await second!()
  })

  it('serves waiters in arrival order', async () => {
    const order: string[] = []
    const first = await acquireStateLock('/state/order.lock', 'order')
    const a = acquireStateLock('/state/order.lock', 'order').then(async (release) => { order.push('a'); await release() })
    const b = acquireStateLock('/state/order.lock', 'order').then(async (release) => { order.push('b'); await release() })
    await first()
    await Promise.all([a, b])
    expect(order).toEqual(['a', 'b'])
  })
})
