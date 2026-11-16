// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * A return to the app reads a push-fed model again (`refreshOnFocus`), once per return: having left (no Gugu window has
 * the focus, or the page hidden), coming back. Focus moving inside the app is no return.
 */
const host = vi.hoisted(() => ({ active: null as null | ((active: boolean) => void) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { subscribeAppActive: (listener: (active: boolean) => void) => { host.active = listener; listener(true); return () => { host.active = null } } },
}))

const rm = await import('../../../../apps/desktop/src/lib/replica')
const { installReadOnReturn } = await import('../../../../apps/desktop/src/lib/foregroundReturn')

const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  rm.followRendererSession('SIGNED_IN', 'alice')
})
afterEach(() => { vi.restoreAllMocks(); rm.queryClient.clear() })

async function shown(name: string) {
  const reads = vi.fn(async () => 'v')
  const model = rm.replica({ name, scope: 'account', fresh: Infinity, refreshOnFocus: true, read: reads })
  function Probe() { rm.useReplica(model, []); return null }
  const harness = createReactHarness()
  await harness.render(createElement(Probe)); await settle()
  expect(reads).toHaveBeenCalledTimes(1)
  return { reads, harness }
}

describe('a return to the app', () => {
  it('the page becoming visible and the window regaining focus in one return read once', async () => {
    installReadOnReturn()
    const { reads, harness } = await shown('test-return-once')
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange', { bubbles: true })); host.active?.(false)
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
    // The return's read has landed before the window's focus arrives (a fast read, e.g. this machine's host).
    await vi.waitFor(() => expect(reads).toHaveBeenCalledTimes(2)); await settle()
    window.dispatchEvent(new Event('focus')); host.active?.(true); await settle()
    expect(reads).toHaveBeenCalledTimes(2)
    harness.cleanup({ keepReads: true })
  })

  it('focus moving inside the app (never left) reads nothing', async () => {
    installReadOnReturn()
    const { reads, harness } = await shown('test-return-inside')
    window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); await settle()
    window.dispatchEvent(new Event('focus')); await settle()
    expect(reads).toHaveBeenCalledTimes(1)
    // Another application had the focus: a return.
    host.active?.(false); host.active?.(true); await settle()
    expect(reads).toHaveBeenCalledTimes(2)
    harness.cleanup({ keepReads: true })
  })
})
