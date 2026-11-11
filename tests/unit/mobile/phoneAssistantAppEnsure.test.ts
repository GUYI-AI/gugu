import { describe, expect, it, vi } from 'vitest'
import { createPhoneAssistantAppEnsure } from '../../../apps/desktop/src/components/appSlot/phoneAssistantAppEnsure'

/**
 * #1931 on a phone: the assistant App put in by itself where the account has an assistant — from the market as gugu's own,
 * in the background, retried with the desktop's backoff, never asked; an App with its id already here is left as it is.
 */

function world(overrides: { installed?: boolean; fails?: number } = {}) {
  let installed = overrides.installed ?? false
  let fails = overrides.fails ?? 0
  const install = vi.fn(async () => {
    if (fails > 0) { fails -= 1; throw new Error('market down') }
    installed = true
  })
  const sleep = vi.fn(async (_ms: number) => undefined)
  const ensure = createPhoneAssistantAppEnsure({ installed: () => installed, install, ready: async () => undefined, sleep }, [10, 20, 30])
  return { ensure, install, sleep, uninstall: () => { installed = false } }
}

describe('the assistant App on a phone (ensure)', () => {
  it('goes in, unasked, once the account\'s assistant is known, and not before', async () => {
    const w = world()
    expect(await w.ensure.ensure(false)).toBe('not-needed')
    expect(w.install).not.toHaveBeenCalled()
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(w.install).toHaveBeenCalledTimes(1)
    expect(await w.ensure.ensure(true)).toBe('present')
    expect(w.install).toHaveBeenCalledTimes(1)
  })

  it('leaves an App with its id that is already here, whatever its origin', async () => {
    const w = world({ installed: true })
    expect(await w.ensure.ensure(true)).toBe('present')
    expect(w.install).not.toHaveBeenCalled()
  })

  it('goes back in after the person removed it, while they have an assistant', async () => {
    const w = world()
    await w.ensure.ensure(true)
    w.uninstall()
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(w.install).toHaveBeenCalledTimes(2)
  })

  it('retries with backoff, says stuck once the window is spent, and clears it when it finally goes in', async () => {
    const w = world({ fails: 3 })
    const heard = vi.fn()
    w.ensure.subscribe(heard)
    expect(await w.ensure.ensure(true)).toBe('installed')
    expect(w.sleep.mock.calls.map(([ms]) => ms)).toEqual([10, 20, 30])
    // Stuck when the last wait of the window began; cleared once it went in.
    expect(heard).toHaveBeenCalledTimes(2)
    expect(w.ensure.stuck()).toBe(false)
  })

  it('joins one attempt however often it is asked while running', async () => {
    const w = world({ fails: 1 })
    const [a, b] = await Promise.all([w.ensure.ensure(true), w.ensure.ensure(true)])
    expect([a, b]).toEqual(['installed', 'installed'])
    expect(w.install).toHaveBeenCalledTimes(2)
  })
})
