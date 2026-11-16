// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * A return to the app reads a push-fed model again (`refreshOnFocus`), once per return: the host says the person left the
 * app and came back (main.ts @@@app-presence; switching between Gugu windows is no leaving there). Focus or visibility
 * moving inside the app is no return.
 */
const host = vi.hoisted(() => ({ presence: null as null | ((present: boolean) => void) }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    subscribeAppPresence: (listener: (present: boolean) => void) => { host.presence = listener; listener(true); return () => { host.presence = null } },
    // The window-focus answer (main.ts @@@app-active) stays "a Gugu window has the focus" throughout these switches.
    subscribeAppActive: (listener: (active: boolean) => void) => { listener(true); return () => undefined },
  },
}))

const rm = await import('../../../../apps/desktop/src/lib/replica')
const { installReadOnReturn } = await import('../../../../apps/desktop/src/lib/foregroundReturn')

const settle = async () => { for (let i = 0; i < 5; i += 1) await Promise.resolve() }
let visibility: DocumentVisibilityState = 'visible'

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility)
  rm.followRendererSession('SIGNED_IN', 'alice')
  installReadOnReturn()
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

const switchVisibility = async (next: DocumentVisibilityState) => {
  visibility = next
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
  await settle()
}

describe('a return to the app', () => {
  it('left and came back: read once; told it is here again without having left: nothing', async () => {
    const { reads, harness } = await shown('test-return-once')
    host.presence?.(false); host.presence?.(true); await settle()
    expect(reads).toHaveBeenCalledTimes(2)
    host.presence?.(true); await settle()
    expect(reads).toHaveBeenCalledTimes(2)
    harness.cleanup({ keepReads: true })
  })

  it('focus and visibility moving inside the app (a window covered by another Gugu window, an App page focused) read nothing', async () => {
    const { reads, harness } = await shown('test-return-inside')
    window.dispatchEvent(new Event('blur')); window.dispatchEvent(new Event('focus')); await settle()
    await switchVisibility('hidden'); await switchVisibility('visible')
    window.dispatchEvent(new Event('focus')); await settle()
    expect(reads).toHaveBeenCalledTimes(1)
    harness.cleanup({ keepReads: true })
  })
})
