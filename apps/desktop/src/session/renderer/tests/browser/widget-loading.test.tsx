import { createRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { WidgetSnapshot } from '@/components/chat/WidgetSnapshot'
import { WIDGET_SNAPSHOT_EVENT, widgetSnapshotKey } from '@/lib/widgetSnapshots'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

const cache = vi.hoisted(() => ({ picture: null as Blob | null }))
vi.mock('@/lib/widgetSnapshots', async original => ({ ...(await original<object>()), widgetSnapshots: { read: async () => cache.picture } }))
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'reader' } }) }))
vi.mock('@/store/theme', async original => ({ ...(await original<object>()), useTheme: () => ({ theme: 'light' }) }))
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }))
let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); cache.picture = null })

it('keeps the full slot while loading, reading a real WebP and revealing a painted page', async () => {
  harness = createReactHarness()
  const ref = createRef<HTMLDivElement>()
  const view = (visible: boolean, inactive = false) => <div ref={ref} style={{ position: 'relative', width: 400, height: 240 }}>
    <WidgetSnapshot widgetId="widget" text="Counter" element={ref} visible={visible} inactive={inactive} />
  </div>
  await harness.render(view(true))
  expect(ref.current!.getBoundingClientRect().height).toBe(240)
  const loading = harness.container.querySelector<HTMLElement>('[data-widget-loading]')!
  expect(loading.getBoundingClientRect().height).toBe(240)
  expect(loading.textContent).toContain('Counter')
  expect(harness.container.querySelector('img')).toBeNull()
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2
  canvas.getContext('2d')!.fillRect(0, 0, 2, 2)
  cache.picture = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp'))
  expect(cache.picture?.type).toBe('image/webp')
  window.dispatchEvent(new CustomEvent(WIDGET_SNAPSHOT_EVENT, { detail: widgetSnapshotKey('reader', 'widget', 'light', 400) }))
  await until('the local image replaces the same-height loading placeholder', () => !!harness.container.querySelector('img'))
  const image = harness.container.querySelector('img')!
  await image.decode()
  expect(image.naturalWidth).toBe(2)
  expect(harness.container.querySelector('[data-widget-loading]')).toBeNull()
  await harness.render(view(true, true))
  expect(getComputedStyle(image).filter).toBe('grayscale(1)')
  expect(ref.current!.getBoundingClientRect().height).toBe(240)
  await harness.render(view(false))
  expect(harness.container.querySelector('img')).toBeNull()
  expect(ref.current!.getBoundingClientRect().height).toBe(240)
})

it('paints a picture it has read before in the first frame of a slot mounted again, before storage answers', async () => {
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2
  cache.picture = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp'))
  const ref = createRef<HTMLDivElement>()
  const view = <div ref={ref} style={{ position: 'relative', width: 400, height: 240 }}>
    <WidgetSnapshot widgetId="again" text="Counter" element={ref} visible />
  </div>
  harness = createReactHarness()
  await harness.render(view)
  await until('the picture is read once', () => !!harness.container.querySelector('img'))
  harness.cleanup()
  // Back in the conversation: storage is slow to answer now, and the first frame must not wait for it.
  cache.picture = null
  harness = createReactHarness()
  await harness.render(view)
  expect(harness.container.querySelector('img')).not.toBeNull()
  expect(harness.container.querySelector('[data-widget-loading]')).toBeNull()
})

it('keeps showing a slot\'s picture when another slot of the same widget reads a newer one', async () => {
  const picture = async (size: number) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = size
    return new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp'))
  }
  const narrow = createRef<HTMLDivElement>(), wide = createRef<HTMLDivElement>()
  harness = createReactHarness()
  cache.picture = await picture(2)
  await harness.render(<div ref={narrow} style={{ position: 'relative', width: 400, height: 240 }}>
    <WidgetSnapshot widgetId="shared" text="Counter" element={narrow} visible />
  </div>)
  await until('the first slot shows its picture', () => !!harness.container.querySelector('img'))
  cache.picture = await picture(3)
  await harness.render(<>
    <div ref={narrow} style={{ position: 'relative', width: 400, height: 240 }}><WidgetSnapshot widgetId="shared" text="Counter" element={narrow} visible /></div>
    <div ref={wide} style={{ position: 'relative', width: 480, height: 240 }}><WidgetSnapshot widgetId="shared" text="Counter" element={wide} visible /></div>
  </>)
  await until('the second slot shows the newer picture', () => [...harness.container.querySelectorAll('img')].some(image => image.complete && image.naturalWidth === 3))
  // Every picture shown still loads where it is drawn again (a slot remounted, a repaint): none was revoked under it.
  for (const image of harness.container.querySelectorAll('img')) {
    const again = new Image()
    again.src = image.src
    await again.decode()
    expect(again.naturalWidth).toBeGreaterThan(0)
  }
})
