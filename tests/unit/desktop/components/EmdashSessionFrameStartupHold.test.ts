// @vitest-environment jsdom
// Cold start keeps one loader (spec loading-state, #2571): while the startup wordmark is still up, the task page frame holds
// it until the task page has drawn or failed, instead of drawing a second loader after it. A later load, with no wordmark
// left, shows the ordinary loader.
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const platform = vi.hoisted(() => ({ kind: 'electron' as 'electron' | 'web' }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform }))

// The web build's session host: one that never connects (the frame shows "host not connected").
vi.mock('../../../../apps/desktop/src/lib/session-host-ws-client', () => ({
  resolveSessionHostEndpoint: () => 'ws://127.0.0.1:1/host',
  createSessionHostWsClient: () => ({
    endpoint: { url: 'ws://127.0.0.1:1/host' },
    state: () => 'closed',
    onStateChange: () => () => undefined,
    api: { invoke: vi.fn(async () => undefined) },
    connect: async () => undefined,
  }),
}))
vi.mock('../../../../apps/desktop/src/lib/session-shell-auth-handoff', () => ({ installSessionShellAuthHandoff: () => undefined }))

const entry = vi.hoisted(() => {
  const pending: Array<{ resolve: (value?: unknown) => void; reject: (error: unknown) => void }> = []
  return {
    pending,
    importSessionEntry: vi.fn((_url: string) => new Promise<unknown>((resolve, reject) => { pending.push({ resolve, reject }) })),
  }
})
vi.mock('../../../../apps/desktop/src/components/sessionpage/importSessionEntry', () => ({
  importSessionEntry: entry.importSessionEntry,
}))

// The startup wordmark: whether it is still up, and who holds it.
const startup = vi.hoisted(() => {
  const listeners = new Set<() => void>()
  const state = { shown: false, holders: 0, release: vi.fn() }
  return {
    state,
    listeners,
    set(shown: boolean) { state.shown = shown; listeners.forEach((listener) => listener()) },
    hasStartupMotion: () => state.shown,
    subscribeStartupMotion: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    retainStartupMotion: vi.fn(() => {
      state.holders += 1
      return () => { state.holders -= 1; state.release() }
    }),
  }
})
vi.mock('../../../../apps/desktop/src/lib/startup-motion', () => ({
  hasStartupMotion: startup.hasStartupMotion,
  subscribeStartupMotion: startup.subscribeStartupMotion,
  retainStartupMotion: startup.retainStartupMotion,
}))

import { EmdashSessionFrame } from '../../../../apps/desktop/src/components/sessionpage/EmdashSessionFrame'
import { SESSION_HOST_BRIDGE_KEY } from '../../../../apps/desktop/src/session/renderer/lib/electron-api'
import { reportSessionRendererBootFailure } from '../../../../apps/desktop/src/session/shared/lib/session-renderer-boot'
import { createReactHarness } from '../../../support/testHarness'

const MODULE_SRC = './assets/session-embedded-startup-hold.js'
const sessionMount = () => (window as unknown as { __EMDASH_MOUNT__?: HTMLElement }).__EMDASH_MOUNT__

describe('task page frame on a cold start', () => {
  let harness: ReturnType<typeof createReactHarness>
  const loader = () => harness.container.querySelector('[role=status]')
  const errorCard = () => harness.container.querySelector('[role=alert]')
  // MainLayout sizes the frame over its slot when the task page is on screen; behind another page it stays 0 × 0.
  let onScreen = true

  beforeEach(() => {
    entry.pending.length = 0
    entry.importSessionEntry.mockClear()
    startup.retainStartupMotion.mockClear()
    startup.state.release.mockClear()
    startup.state.holders = 0
    startup.set(false)
    ;(window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY] = { invoke: vi.fn(async () => undefined) }
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, text: async () => `<script type="module" src="${MODULE_SRC}"></script>` })))
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    onScreen = true
    platform.kind = 'electron'
    const rect = HTMLElement.prototype.getBoundingClientRect
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (!this.classList.contains('gg-session-frame')) return rect.call(this)
      return { x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0, width: onScreen ? 900 : 0, height: onScreen ? 700 : 0, toJSON: () => ({}) } as DOMRect
    })
    harness = createReactHarness()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    harness.cleanup()
    vi.unstubAllGlobals()
    delete (window as unknown as Record<string, unknown>)[SESSION_HOST_BRIDGE_KEY]
  })

  async function renderUntilEntryImported() {
    await harness.render(createElement(EmdashSessionFrame))
    while (entry.pending.length === 0) await act(async () => { await Promise.resolve() })
    return entry.pending[0]!
  }

  it('holds the wordmark while the task page loads, draws no loader of its own, and lets go once the page has drawn', async () => {
    startup.set(true)
    const imported = await renderUntilEntryImported()
    await act(async () => { imported.resolve() })

    expect(startup.state.holders).toBe(1)
    expect(loader()).toBeNull()

    await act(async () => { sessionMount()?.appendChild(document.createElement('div')) })

    expect(startup.state.holders).toBe(0)
    expect(startup.state.release).toHaveBeenCalledTimes(1)
    expect(loader()).toBeNull()
  })

  it('lets go of the wordmark when the task page fails, so its error card is usable', async () => {
    startup.set(true)
    const imported = await renderUntilEntryImported()
    await act(async () => { imported.resolve() })
    expect(startup.state.holders).toBe(1)

    await act(async () => { reportSessionRendererBootFailure(new Error('bootstrap exploded')) })

    expect(startup.state.holders).toBe(0)
    expect(errorCard()).not.toBeNull()
  })

  it('a load after startup, with no wordmark left, shows the ordinary loader and holds nothing', async () => {
    const imported = await renderUntilEntryImported()
    await act(async () => { imported.resolve() })

    expect(startup.retainStartupMotion).not.toHaveBeenCalled()
    expect(loader()).not.toBeNull()
  })

  it('the ordinary loader takes over if the wordmark goes away while the page is still loading', async () => {
    startup.set(true)
    const imported = await renderUntilEntryImported()
    await act(async () => { imported.resolve() })
    expect(loader()).toBeNull()

    await act(async () => { startup.set(false) })

    expect(startup.state.holders).toBe(0)
    expect(loader()).not.toBeNull()
  })

  it('warming up behind another page, it lets go of the wordmark at once: that page is what is on screen', async () => {
    onScreen = false
    startup.set(true)
    const imported = await renderUntilEntryImported()
    await act(async () => { imported.resolve() })

    expect(startup.state.holders).toBe(0)
    expect(startup.state.release).toHaveBeenCalledTimes(1)
  })

  // Web build with no session host: the frame shows "host not connected" while its page never loads.
  it('lets go of the wordmark when the web build cannot reach its session host, so that card is usable', async () => {
    platform.kind = 'web'
    startup.set(true)
    await harness.render(createElement(EmdashSessionFrame))
    await act(async () => { await Promise.resolve() })

    expect(startup.state.holders).toBe(0)
    expect(errorCard()).not.toBeNull()
  })
})
