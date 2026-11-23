// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame'
import { queryClient } from '@/lib/replica'

let harness: ReturnType<typeof createReactHarness>
const queryOptions = queryClient.getDefaultOptions()
beforeEach(() => { queryClient.setDefaultOptions({ ...queryOptions, queries: { ...queryOptions.queries, retryDelay: 0 } }); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); queryClient.setDefaultOptions(queryOptions) })

describe('shared HTML frame lifecycle', () => {

  it('does not navigate for an unrelated file or unchanged resync; one changed burst updates once', async () => {
    let changed!: (paths?: readonly string[]) => void
    const subscribeChanges = (listener: typeof changed) => { changed = listener; return vi.fn() }
    const update = vi.fn(async () => 'blob:next')
    const assetsChanged = vi.fn(async (paths?: string[]) => paths?.includes('used.css') ?? false)
    const register = vi.fn(async (): Promise<HtmlPreviewRegistration> => ({ ok: true, url: 'blob:initial', update, release: vi.fn(), assetsChanged }))
    await harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent: 'page', register, onLink: vi.fn(), subscribeChanges }))
    await until('the registered frame listens for workspace changes', () => changed !== undefined)
    vi.useFakeTimers()
    try {
      await act(async () => { changed(['other.md', 'sub/shot.png']); await vi.advanceTimersByTimeAsync(210) })
      await act(async () => { changed(); await vi.advanceTimersByTimeAsync(210) })
      expect(update).not.toHaveBeenCalled()
      expect(harness.container.querySelectorAll('iframe')).toHaveLength(1)
      await act(async () => { changed(['used.css']); changed(['used.css']); await vi.advanceTimersByTimeAsync(210) })
      await act(async () => { await vi.advanceTimersByTimeAsync(210) })
      expect(update).toHaveBeenCalledExactlyOnceWith('page')
    } finally { vi.useRealTimers() }
  })

  it('shows registration failures and retries when the caller asks to reload', async () => {
    const register = vi.fn<(...args: string[]) => Promise<HtmlPreviewRegistration>>()
      .mockResolvedValue({ ok: false, message: 'Host unavailable' })
    const draw = (reloadKey: number) => harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent: 'body', register, reloadKey, onLink: vi.fn() }))
    await draw(0)
    await until('bounded automatic recovery is exhausted', () => harness.container.textContent!.includes('Host unavailable'))
    expect(register).toHaveBeenCalledTimes(4)
    expect(harness.container.querySelector('iframe')).toBeNull()
    register.mockResolvedValue({ ok: true, url: 'blob:recovered', update: vi.fn(), release: vi.fn() })
    await draw(1)
    await until('host recovery is displayed', () => harness.container.querySelector('iframe')?.getAttribute('src') === 'blob:recovered')
  })

  it('can retry an unavailable registration on workspace recovery without a fetched list yet', async () => {
    let changed!: (paths?: readonly string[]) => void
    const subscribeChanges = (listener: typeof changed) => { changed = listener; return vi.fn() }
    const register = vi.fn<(...args: string[]) => Promise<HtmlPreviewRegistration>>()
      .mockResolvedValue({ ok: false, message: 'Host unavailable' })
    // The bounded recovery waits 1 s, 2 s and 4 s between tries: run on the test's clock.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    try {
      await harness.render(createElement(HtmlPreviewFrame, { fileName: 'report.html', rawContent: 'body', register, subscribeChanges, onLink: vi.fn() }))
      await act(async () => { await vi.advanceTimersByTimeAsync(10_000) })
      expect(harness.container.textContent).toContain('Host unavailable')
      expect(register).toHaveBeenCalledTimes(4)
      register.mockResolvedValue({ ok: true, url: 'blob:recovered', update: vi.fn(), release: vi.fn() })
      await act(async () => { changed(); await vi.advanceTimersByTimeAsync(220) })
      expect(register).toHaveBeenCalledTimes(5)
      expect(harness.container.querySelector('iframe')?.getAttribute('src')).toBe('blob:recovered')
    } finally {
      vi.useRealTimers()
    }
  })
})
