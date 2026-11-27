import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { ExtensionPage } from '@renderer/features/extensions/extension-view-layer'
import { extensionViewStore, residentPageKey, residentPlace } from '@renderer/features/extensions/extension-view-store'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'

// The native page is placed where the layer placed its box (@@@place-reads-first): the layout reported to the main process is
// computed from the boxes the placing has just written, ❌ read back off the elements after those writes (each read laid the
// whole page out again in a panel's frame). What is reported must still be where the page and its clip are drawn.
vi.mock('@/components/preview/file-content-zoom', async original => ({ ...(await original<object>()), bindAppPageZoom: () => () => {} }))
vi.mock('@/store/theme', async original => ({ ...(await original<object>()), useTheme: () => ({ theme: 'light' }) }))

type Reported = { x: number; y: number; width: number; height: number; visible: boolean; clip: { x: number; y: number; width: number; height: number } }
let harness: ReturnType<typeof createReactHarness>, slot: HTMLElement
afterEach(() => {
  harness?.cleanup()
  act(() => extensionViewStore.forgetOpened('placed.main'))
  slot?.remove()
  vi.unstubAllGlobals()
})

it('reports the page and its clip where they are drawn, placed and as the slot moves', async () => {
  harness = createReactHarness()
  // A layer off the viewport origin by a fraction of a pixel, and a slot clipped by its parent on the right.
  Object.assign(harness.container.style, { position: 'fixed', left: '10.5px', top: '7.25px', width: '900px', height: '700px' })
  const frame = document.createElement('div')
  Object.assign(frame.style, { position: 'fixed', left: '40px', top: '30px', width: '300px', height: '400px', overflow: 'hidden' })
  slot = document.createElement('div')
  Object.assign(slot.style, { position: 'absolute', left: '20px', top: '10px', width: '400px', height: '300px', borderRadius: '12px' })
  frame.append(slot)
  document.body.append(frame)
  const reports: Reported[] = []
  vi.stubGlobal('electronAPI', { eventOn: () => () => {}, invoke: async (channel: string, payload?: Reported) => {
    if (channel === 'extensions.activate') return { success: true, data: { partition: 'placed', entryUrl: 'about:blank' } }
    if (channel === 'extensions.bindSurface') return { success: true }
    if (channel === 'extensions.reportLayout') { reports.push(payload!); return { success: true } }
    if (channel === 'log:write') return { success: true }
    throw new Error(`Unexpected bridge call: ${channel}`)
  } })
  act(() => { extensionViewStore.claim('placed.main', { chatId: 'chat', tabId: 'placed-tab', element: slot }) })
  const key = residentPageKey('placed.main', residentPlace({ chatId: 'chat', tabId: 'placed-tab' }))
  await harness.render(<ExtensionPage extensionId="placed" kind="placed.main" pageKey={key} layerRef={{ current: harness.container }} />)
  await until('the resident guest host is mounted', () => !!harness.container.querySelector('webview'))
  const guest = harness.container.querySelector('webview')!
  Object.assign(guest, { getWebContentsId: () => 654 })
  act(() => guest.dispatchEvent(new Event('dom-ready')))
  const box = guest.closest<HTMLElement>('[data-extension-view]')!
  const drawn = () => {
    const page = guest.getBoundingClientRect(), clip = box.getBoundingClientRect()
    const x = Math.max(0, clip.x, page.x), y = Math.max(0, clip.y, page.y)
    return { x: page.x, y: page.y, clip: { x, y, width: Math.min(innerWidth, clip.right, page.right) - x, height: Math.min(innerHeight, clip.bottom, page.bottom) - y } }
  }
  const matches = () => {
    const last = reports.at(-1), now = drawn()
    return !!last && Math.abs(last.x - now.x) < 0.01 && Math.abs(last.y - now.y) < 0.01 &&
      (['x', 'y', 'width', 'height'] as const).every((k) => Math.abs(last.clip[k] - now.clip[k]) < 0.01)
  }
  await until('the first report is where the page is drawn', () => reports.length > 0 && matches())
  expect(reports.at(-1)!.clip.width, 'clipped by the frame on the right').toBeLessThan(400)

  // The slot moves and resizes (a panel's frame): followed, and reported where it is now drawn.
  Object.assign(slot.style, { left: '-30px', top: '25px', width: '360px', height: '280px' })
  await until('the report follows the moved slot', () => matches() && reports.at(-1)!.x === drawn().x)
  expect(drawn().x, 'clipped by the frame on the left now').toBeLessThan(frame.getBoundingClientRect().x)
})
