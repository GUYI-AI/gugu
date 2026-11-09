import { describe, expect, it, vi } from 'vitest'
import { createSelfGuguNumber, SELF_GUGU_NUMBER_RETRY_MS } from '../../../../apps/desktop/electron/self-gugu-number'

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function harness(lookup: (userId: string) => Promise<number | null>) {
  const state = { userId: 'user-a' as string | null, at: 0 }
  const changed = vi.fn()
  const failed = vi.fn()
  const lookupSpy = vi.fn(lookup)
  const read = createSelfGuguNumber({ userId: () => state.userId, lookup: lookupSpy, changed, failed, now: () => state.at })
  return { state, read, changed, failed, lookup: lookupSpy }
}

describe('the account\'s own 咕咕号 for App contexts', () => {
  it('is looked up once per account and announced when it arrives', async () => {
    const h = harness(async (userId) => (userId === 'user-a' ? 100023 : 100024))
    expect(h.read()).toBeUndefined()
    expect(h.read()).toBeUndefined()
    await settle()
    expect(h.read()).toBe(100023)
    expect(h.lookup).toHaveBeenCalledTimes(1)
    expect(h.changed).toHaveBeenCalledTimes(1)
    h.state.userId = 'user-b'
    expect(h.read()).toBeUndefined()
    await settle()
    expect(h.read()).toBe(100024)
  })

  it('is nothing while signed out', () => {
    const h = harness(async () => 1)
    h.state.userId = null
    expect(h.read()).toBeUndefined()
    expect(h.lookup).not.toHaveBeenCalled()
  })

  it('says a failed lookup (null, reported) and tries again a minute later', async () => {
    let fail = true
    const h = harness(async () => { if (fail) throw new Error('offline'); return 100023 })
    h.read()
    await settle()
    expect(h.failed).toHaveBeenCalledTimes(1)
    expect(h.changed).toHaveBeenCalledTimes(1)
    expect(h.read()).toBeNull()
    expect(h.lookup).toHaveBeenCalledTimes(1)
    fail = false
    h.state.at = SELF_GUGU_NUMBER_RETRY_MS
    expect(h.read()).toBeNull()
    await settle()
    expect(h.read()).toBe(100023)
    expect(h.changed).toHaveBeenCalledTimes(2)
  })
})
