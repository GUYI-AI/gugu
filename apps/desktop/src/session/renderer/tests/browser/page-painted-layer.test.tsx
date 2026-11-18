import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionPage } from '@renderer/features/extensions/extension-view-layer'
import { extensionViewStore, residentPageKey, residentPlace } from '@renderer/features/extensions/extension-view-store'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

// An App's page in a tab (not a widget) stays clear until its document's first paint, the loading mark over it, and is
// shown at the first paint, or after three seconds from a guest that never says so — being loaded is not enough.
// A tab's page is zoomed by the host (zoom B): not what is measured here.
vi.mock('@/components/preview/file-content-zoom', async original => ({ ...(await original<object>()), bindAppPageZoom: () => () => {} }))
vi.mock('@/store/theme', async original => ({ ...(await original<object>()), useTheme: () => ({ theme: 'light' }) }))
vi.mock('@renderer/features/extensions/installed-extensions-store', async original => ({ ...(await original<object>()), installedExtensionsStore: { manifestFor: () => undefined } }))

let harness: ReturnType<typeof createReactHarness>, slot: HTMLElement
afterEach(() => {
  harness?.cleanup()
  act(() => extensionViewStore.forgetOpened('pages.main'))
  slot?.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function mount(tabId: string) {
  harness = createReactHarness()
  slot = document.createElement('div')
  Object.assign(slot.style, { position: 'fixed', top: '20px', left: '20px', width: '400px', height: '300px' })
  document.body.append(slot)
  vi.stubGlobal('electronAPI', { eventOn: () => () => {}, invoke: async (channel: string) => {
    if (channel === 'extensions.activate') return { success: true, data: { partition: 'pages', entryUrl: 'about:blank' } }
    if (channel === 'extensions.bindSurface') return { success: true }
    if (channel === 'extensions.reportLayout') return { success: true }
    throw new Error(`Unexpected bridge call: ${channel}`)
  } })
  act(() => { extensionViewStore.claim('pages.main', { chatId: 'chat', tabId, element: slot }) })
  const key = residentPageKey('pages.main', residentPlace({ chatId: 'chat', tabId }))
  await harness.render(<ExtensionPage extensionId="pages" kind="pages.main" pageKey={key} layerRef={{ current: harness.container }} />)
  await until('the resident guest host is mounted', () => !!harness.container.querySelector('webview'))
  const guest = harness.container.querySelector('webview')!
  Object.assign(guest, { getWebContentsId: () => 321 })
  return { key, guest, box: guest.closest<HTMLElement>('[data-extension-view]')! }
}

it('a tab\'s page is clear until its first paint, then drawn', async () => {
  const { key, guest, box } = await mount('panel-tab')
  // From the moment the page is asked for, before its guest is ready: the mark is there (a waiting tab's ends as this starts).
  expect(box.querySelector('[data-testid="page-loading"]')).not.toBeNull()
  act(() => guest.dispatchEvent(new Event('dom-ready')))
  expect(guest.className).toContain('opacity-0')
  expect(box.className).not.toContain('bg-background')
  expect(box.querySelector('[data-testid="page-loading"]')).not.toBeNull()
  expect(extensionViewStore.paintedPages.has(key)).toBe(false)
  act(() => guest.dispatchEvent(Object.assign(new Event('ipc-message'), { channel: 'gugu-page-painted', args: [] })))
  await until('the page is painted', () => extensionViewStore.paintedPages.has(key))
  expect(guest.className).not.toContain('opacity-0')
  expect(box.className).toContain('bg-background')
  expect(box.querySelector('[data-testid="page-loading"]')).toBeNull()
})

it('a guest that never says it painted is shown after three seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { key, guest } = await mount('silent-tab')
  act(() => guest.dispatchEvent(new Event('dom-ready')))
  await vi.advanceTimersByTimeAsync(2_900)
  expect(extensionViewStore.paintedPages.has(key)).toBe(false)
  await vi.advanceTimersByTimeAsync(200)
  expect(extensionViewStore.paintedPages.has(key)).toBe(true)
})

it('loaded with nothing drawn yet (its file still being read): still clear, until its first paint or the three seconds', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'requestAnimationFrame', 'cancelAnimationFrame'] })
  const { key, guest } = await mount('loaded-tab')
  act(() => guest.dispatchEvent(new Event('dom-ready')))
  act(() => guest.dispatchEvent(new Event('did-finish-load')))
  await vi.advanceTimersByTimeAsync(2_000)
  expect(extensionViewStore.paintedPages.has(key)).toBe(false)
  expect(guest.className).toContain('opacity-0')
  await vi.advanceTimersByTimeAsync(1_100)
  expect(extensionViewStore.paintedPages.has(key)).toBe(true)
})

it('a page asked for whose guest never reaches dom-ready: its loading mark goes after three seconds, the page box drawn plain', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const { key, box } = await mount('stuck-tab')
  expect(box.querySelector('[data-testid="page-loading"]')).not.toBeNull()
  await vi.advanceTimersByTimeAsync(2_900)
  expect(extensionViewStore.paintedPages.has(key)).toBe(false)
  await vi.advanceTimersByTimeAsync(200)
  expect(extensionViewStore.paintedPages.has(key)).toBe(true)
  expect(box.querySelector('[data-testid="page-loading"]')).toBeNull()
  expect(box.className).toContain('bg-background')
})
