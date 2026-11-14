import { useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { page } from 'vitest/browser'
import { WidgetBubble } from '@/components/chat/WidgetBubble'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

vi.mock('@/platform', async original => ({ ...(await original<object>()), platform: { kind: 'phone' } }))
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'reader' } }) }))
// Not covered by another shell page; what the scroller shows is measured by the real presence hook.
vi.mock('@/components/chat/useConversationVisibility', () => ({ useConversationVisibility: () => ({ ref: useRef(null), shown: true }) }))
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: {} }))
vi.mock('@/components/appSlot/PhoneAppFrame', () => ({ PhoneAppFrame: () => <iframe title="preloaded widget" data-testid="widget-frame" /> }))
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', async original => ({ ...(await original<object>()), installedExtensionsStore: {
  isLoaded: true, isEnabled: () => true,
  manifestFor: () => ({ id: 'vote', version: '1.0.0', contributes: { tabs: [{ name: 'poll', widget: { height: 64 } }] } }),
} }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

it('preloads one upcoming phone iframe within half of the real scroller and gives a visible slot priority', async () => {
  await page.viewport(412, 844)
  harness = createReactHarness()
  const widget = { v: 2 as const, app: 'vote', view: 'poll', text: 'Vote', height: 64 }
  const message = { id: 'origin', chat_id: 'chat', sender_user_id: 'sender', content: JSON.stringify(widget) }
  const resolved = { id: 'widget', widget, senderId: 'sender' }
  await harness.render(<div data-scroller style={{ height: 400, width: 360, overflowY: 'auto' }}>
      <div style={{ height: 450 }} />
      <WidgetBubble message={message} slotMessageId="first" referenceWidget={resolved} />
      <WidgetBubble message={message} slotMessageId="second" referenceWidget={resolved} />
      <div style={{ height: 1500 }} />
  </div>)
  const frame = () => harness.container.querySelector('iframe')
  const slot = () => frame()?.closest('[data-widget-bubble]')?.getAttribute('data-widget-bubble')
  await until('only the lower nearby reference preloads', () => slot() === 'second')
  expect(harness.container.querySelectorAll('iframe')).toHaveLength(1)
  const scroller = harness.container.querySelector<HTMLElement>('[data-scroller]')!
  expect(frame()!.getBoundingClientRect().top).toBeGreaterThan(scroller.getBoundingClientRect().bottom)
  scroller.scrollTop = 100
  await until('the visible first slot keeps the iframe from the offscreen reference', () => slot() === 'first')
  expect(harness.container.querySelectorAll('iframe')).toHaveLength(1)
  // Horizontal clipping does not lower the required half-height threshold.
  const second = harness.container.querySelector<HTMLElement>('[data-widget-bubble="second"]')!
  second.style.width = '900px'
  second.style.maxWidth = 'none'
  scroller.scrollTop = 350
  await until('the fully visible lower reference takes ownership', () => slot() === 'second')
  scroller.scrollTop = 1200
  await until('outside the half-screen margin there is no phone iframe', () => frame() === null)
})
