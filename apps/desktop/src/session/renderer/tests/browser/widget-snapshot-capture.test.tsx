import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionPage } from '@renderer/features/extensions/extension-view-layer'
import { extensionViewStore, residentPageKey, residentPlace } from '@renderer/features/extensions/extension-view-store'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

const saved = vi.hoisted(() => ({ put: vi.fn(async () => true), capture: vi.fn(async () => ({ success: true, data: 'data:image/png;base64,fixture' })) }))
vi.mock('@/lib/widgetSnapshots', async original => ({ ...(await original<object>()),
  widgetSnapshots: { capture: () => ({ accountId: 'reader', generation: 1 }), put: saved.put },
  widgetSnapshotWebP: async () => new Blob(['picture'], { type: 'image/webp' }),
}))
vi.mock('@/store/theme', async original => ({ ...(await original<object>()), useTheme: () => ({ theme: 'light' }) }))
vi.mock('@renderer/features/extensions/installed-extensions-store', async original => ({ ...(await original<object>()), installedExtensionsStore: { manifestFor: () => undefined } }))

let harness: ReturnType<typeof createReactHarness>, slot: HTMLElement
afterEach(() => {
  harness?.cleanup()
  act(() => extensionViewStore.forgetOpened('snapshot.main'))
  slot?.remove()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('saves the trailing input after the two-second capture interval and refuses a now-hidden slot', async () => {
  harness = createReactHarness()
  slot = document.createElement('div')
  Object.assign(slot.style, { position: 'fixed', top: '20px', left: '20px', width: '400px', height: '200px' })
  document.body.append(slot)
  const bind = vi.fn(async () => ({ success: true }))
  vi.stubGlobal('electronAPI', { eventOn: () => () => {}, invoke: async (channel: string) => {
    if (channel === 'extensions.activate') return { success: true, data: { partition: 'snapshot', entryUrl: 'about:blank' } }
    if (channel === 'extensions.bindSurface') return bind()
    if (channel === 'extensions.captureWidget') return saved.capture()
    if (channel === 'extensions.reportLayout') return { success: true }
    throw new Error(`Unexpected bridge call: ${channel}`)
  } })
  const widget = { id: 'widget', originMessageId: 'origin', messageId: 'reference', data: {}, senderId: 'sender' }
  act(() => extensionViewStore.claim('snapshot.main', { chatId: 'chat', accountId: 'reader', tabId: 'widget:widget', widget, element: slot }))
  const key = residentPageKey('snapshot.main', residentPlace({ chatId: 'chat', widget }))
  await harness.render(<ExtensionPage extensionId="snapshot" kind="snapshot.main" pageKey={key} layerRef={{ current: harness.container }} />)
  await until('the resident guest host is mounted', () => !!harness.container.querySelector('webview'))
  const guest = harness.container.querySelector('webview')!
  Object.assign(guest, { getWebContentsId: () => 123 })
  act(() => guest.dispatchEvent(new Event('dom-ready')))
  await until('the guest is bound through the normal bridge', () => bind.mock.calls.length === 1)
  await Promise.resolve()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const send = (channel: string) => guest.dispatchEvent(Object.assign(new Event('ipc-message'), { channel, args: [] }))
  act(() => send('gugu-widget-painted'))
  await vi.advanceTimersByTimeAsync(0)
  expect(saved.capture).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(250)
  send('gugu-widget-changed')
  await vi.advanceTimersByTimeAsync(1000)
  expect(saved.capture).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(750)
  expect(saved.capture).toHaveBeenCalledTimes(2)
  expect(saved.put).toHaveBeenCalledTimes(2)
  send('gugu-widget-changed')
  slot.style.display = 'none'
  await vi.advanceTimersByTimeAsync(2000)
  expect(saved.capture).toHaveBeenCalledTimes(2)
})
