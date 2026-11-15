import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { WidgetBubble } from '@/components/chat/WidgetBubble'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

const fixture = vi.hoisted(() => ({ platform: { kind: 'electron' }, locate: vi.fn(), picture: null as Blob | null }))
vi.mock('@/platform', async original => ({ ...(await original<object>()), platform: fixture.platform }))
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'reader' } }) }))
vi.mock('@/store/theme', async original => ({ ...(await original<object>()), useTheme: () => ({ theme: 'light' }) }))
vi.mock('@/store/chatContext', async original => ({ ...(await original<object>()), useChatStore: () => ({ subscribeAccountRevision: () => () => {} }) }))
vi.mock('@/lib/widgetRegistry', async original => ({ ...(await original<object>()), widgetForOriginal: async () => ({ id: 'widget', widget: { v: 2, app: 'vote', view: 'poll', text: 'Dinner', height: 240 }, senderId: 'sender' }) }))
vi.mock('@/lib/widgetSnapshots', async original => ({ ...(await original<object>()), widgetSnapshots: { read: async () => fixture.picture } }))
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: {} }))
vi.mock('@/components/chat/useConversationVisibility', () => ({ useConversationVisibility: () => ({ ref: useRef(null), shown: true }) }))
// Another slot of the same widget holds its page: this one is inactive.
vi.mock('@/components/chat/useWidgetPresence', () => ({ useWidgetPresence: () => ({ active: false, preload: false, locate: fixture.locate }) }))
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', async original => ({ ...(await original<object>()), installedExtensionsStore: {
  isLoaded: true, isEnabled: () => true,
  manifestFor: () => ({ id: 'vote', version: '1', contributes: { tabs: [{ name: 'poll', widget: { height: 240 } }] } }),
} }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); fixture.locate.mockClear() })

it.each(['electron', 'phone'])('shows an inactive slot as one layer that leads to the live one on %s', async platform => {
  fixture.platform.kind = platform
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = 2
  fixture.picture = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/webp'))
  harness = createReactHarness()
  const message = { id: `${platform}-message`, chat_id: 'chat', sender_user_id: 'sender', content: JSON.stringify({ v: 2, app: 'vote', view: 'poll', text: 'Dinner', height: 240 }) }
  await harness.render(<div style={{ width: 400 }}><WidgetBubble message={message} /></div>)
  await until('the slot is resolved', () => !!harness.container.querySelector('[data-widget-locate]'))
  if (platform === 'electron') await until('the grey snapshot shows', () => !!harness.container.querySelector('[data-widget-snapshot]'))
  const frame = harness.container.querySelector<HTMLElement>('[data-widget-bubble] > div')!
  // One layer of text in the frame: the snapshot's own on desktop, the App's name on phone; no "loading" and no button text.
  expect(frame.textContent).not.toContain('message.reference.loading')
  expect(frame.textContent).not.toContain('message.reference.locateActive')
  const cover = harness.container.querySelector<HTMLElement>('[data-widget-locate]')!
  expect(cover.getBoundingClientRect().height).toBe(240)
  expect(getComputedStyle(cover).cursor).toBe('pointer')
  cover.click()
  const link = [...harness.container.querySelectorAll('button')].find(button => button.textContent === 'message.reference.locateActive')!
  expect(frame.contains(link)).toBe(false)
  expect(link.parentElement!.querySelector('[data-widget-text]')?.textContent).toBe('Dinner')
  link.click()
  expect(fixture.locate).toHaveBeenCalledTimes(2)
})
