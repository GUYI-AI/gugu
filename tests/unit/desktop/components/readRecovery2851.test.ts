// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { queryClient, replica, useReplica } from '@/lib/replica'
import { HtmlPreviewFrame, type HtmlPreviewRegistration } from '@/components/preview/HtmlPreviewFrame'
import { VersionHistorySection } from '@/session/renderer/features/extensions/panel/app-version-history'
import { useVersionHistory } from '@/session/renderer/features/extensions/panel/use-version-history'
import { SettingValue } from '@/session/renderer/features/settings/components/SettingControls'
import { translateSessionMessage } from '@/session/renderer/localization/locale-store'

const defaults = queryClient.getDefaultOptions()
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retryDelay: 0 } })
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); queryClient.setDefaultOptions(defaults) })
const settled = async (check: () => void) => vi.waitFor(async () => { await act(async () => {}); check() })
const registration = (): Extract<HtmlPreviewRegistration, { ok: true }> => ({ ok: true, url: 'about:blank', update: async () => 'about:blank', release: vi.fn() })

describe('HTML registration read recovery', () => {
  it('retries silently and shows the actual preview after a transient refusal', async () => {
    let finish!: (value: HtmlPreviewRegistration) => void
    const register = vi.fn(async (): Promise<HtmlPreviewRegistration> => new Promise(resolve => { finish = resolve }))
      .mockResolvedValueOnce({ ok: false, message: 'Temporary registration failure' })
    await harness.render(createNode(HtmlPreviewFrame, { fileName: 'notes.html', rawContent: '<p>notes</p>', register, onLink: vi.fn() }))
    await settled(() => expect(register).toHaveBeenCalledTimes(2))
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
    await act(async () => finish(registration()))
    await settled(() => expect(harness.container.querySelector('iframe')?.getAttribute('src')).toBe('about:blank'))
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('shows the last reason after bounded retries and re-registers from the fallback control', async () => {
    const register = vi.fn(async (): Promise<HtmlPreviewRegistration> => ({ ok: false, message: 'The preview host is unavailable' }))
    await harness.render(createNode(HtmlPreviewFrame, { fileName: 'notes.html', rawContent: '<p>notes</p>', register, onLink: vi.fn() }))
    await settled(() => expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('The preview host is unavailable'))
    expect(register).toHaveBeenCalledTimes(4)
    register.mockResolvedValue(registration())
    await act(async () => harness.container.querySelector('button')!.click())
    await settled(() => expect(harness.container.querySelector('iframe')).not.toBeNull())
    expect(register).toHaveBeenCalledTimes(5)
  })

  it('releases a registration that finishes after the preview left', async () => {
    let finish!: (value: HtmlPreviewRegistration) => void
    const register = vi.fn(async (): Promise<HtmlPreviewRegistration> => new Promise(resolve => { finish = resolve }))
    await harness.render(createNode(HtmlPreviewFrame, { fileName: 'notes.html', rawContent: '<p>notes</p>', register, onLink: vi.fn() }))
    await harness.render(createNode('div', null, 'closed'))
    const ready = registration()
    await act(async () => finish(ready))
    expect(ready.release).toHaveBeenCalledTimes(1)
    expect(harness.container.querySelector('iframe')).toBeNull()
  })
})

type HistoryApi = Parameters<typeof useVersionHistory>[0]
let refreshHistory: () => void
function History({ api }: { api: HistoryApi }) {
  const history = useVersionHistory(api, 'sample-app')
  refreshHistory = history.retry
  return createNode(VersionHistorySection, { state: history.state, extensionId: 'sample-app', installedVersion: undefined,
    offeredVersion: null, locale: 'en-US', translate: translateSessionMessage, onReadAgain: history.retry, onOpenExternal: vi.fn() })
}

describe('App version history read recovery', () => {
  it('recovers without a click before exposing the failure', async () => {
    const api = { marketHistory: vi.fn().mockResolvedValueOnce({ success: false, error: 'Temporary history failure' })
      .mockResolvedValue({ success: true, data: [] }) }
    await harness.render(createNode(History, { api }))
    await settled(() => expect(harness.container.textContent).toContain(translateSessionMessage('extensions.historyNone')))
    expect(api.marketHistory).toHaveBeenCalledTimes(2)
    expect(harness.container.querySelector('[role="alert"]')).toBeNull()
  })

  it('keeps a previously read history when its refresh persistently fails', async () => {
    const api = { marketHistory: vi.fn().mockResolvedValue({ success: true, data: [] }) }
    await harness.render(createNode(History, { api }))
    await settled(() => expect(harness.container.textContent).toContain(translateSessionMessage('extensions.historyNone')))
    api.marketHistory.mockResolvedValue({ success: false, error: 'History service unavailable' })
    await act(async () => refreshHistory())
    await settled(() => expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('History service unavailable'))
    expect(harness.container.textContent).toContain(translateSessionMessage('extensions.historyNone'))
    expect(api.marketHistory).toHaveBeenCalledTimes(5)
    api.marketHistory.mockResolvedValue({ success: true, data: [] })
    await act(async () => harness.container.querySelector('button')!.click())
    await settled(() => expect(harness.container.querySelector('[role="alert"]')).toBeNull())
    expect(api.marketHistory).toHaveBeenCalledTimes(6)
  })

  it('does not publish an old host response after the source changes', async () => {
    let finish!: (value: { success: boolean; data: [] }) => void
    const old = { marketHistory: vi.fn(() => new Promise<{ success: boolean; data: [] }>(resolve => { finish = resolve })) }
    const current = { marketHistory: vi.fn().mockResolvedValue({ success: false, error: 'Current host refused the read' }) }
    await harness.render(createNode(History, { api: old }))
    await harness.render(createNode(History, { api: current }))
    await settled(() => expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('Current host refused the read'))
    await act(async () => finish({ success: true, data: [] }))
    expect(harness.container.querySelector('[role="alert"]')?.textContent).toBe('Current host refused the read')
  })
})

it('uses replica read recovery without replacing a stored setting or changing unrelated defaults', async () => {
  const read = vi.fn().mockRejectedValueOnce(new Error('Temporary IPC failure')).mockResolvedValue('stored browser profile')
  const model = replica({ name: 'read-recovery-2851', scope: 'device', read })
  function BrowserSetting() {
    const reading = useReplica(model, [], { retry: 3 })
    return createNode(SettingValue, { reading, onReadAgain: () => { void model.refresh() }, children: (value: unknown) => createNode('span', null, String(value)) })
  }
  await harness.render(createNode(BrowserSetting))
  await settled(() => expect(harness.container.textContent).toBe('stored browser profile'))
  expect(read).toHaveBeenCalledTimes(2)
  expect(harness.container.querySelector('[role="alert"]')).toBeNull()
})
