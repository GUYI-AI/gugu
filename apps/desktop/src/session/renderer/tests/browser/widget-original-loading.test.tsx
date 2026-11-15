import { afterEach, expect, it, vi } from 'vitest'
import { WidgetBubble } from '@/components/chat/WidgetBubble'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/styles/tokens.css'
import '@renderer/index.css'

const fixture = vi.hoisted(() => ({ platform: { kind: 'electron' }, read: vi.fn(), claim: vi.fn(() => 'claim'), revision: () => () => {} }))
vi.mock('@/platform', async original => ({ ...(await original<object>()), platform: fixture.platform }))
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'reader' } }) }))
vi.mock('@/store/theme', async original => ({ ...(await original<object>()), useTheme: () => ({ theme: 'light' }) }))
vi.mock('@/store/chatContext', async original => ({ ...(await original<object>()), useChatStore: () => ({ subscribeAccountRevision: fixture.revision }) }))
vi.mock('@/lib/widgetRegistry', async original => ({ ...(await original<object>()), widgetForOriginal: fixture.read }))
vi.mock('@/lib/widgetSnapshots', async original => ({ ...(await original<object>()), widgetSnapshots: { read: async () => null } }))
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: {} }))
vi.mock('@/components/appSlot/PhoneAppFrame', () => ({ PhoneAppFrame: () => <iframe title="resolved original" /> }))
vi.mock('@/session/renderer/features/extensions/extension-view-store', async original => ({ ...(await original<object>()), extensionViewStore: { claim: fixture.claim, release: vi.fn(), paintedPages: new Set() } }))
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', async original => ({ ...(await original<object>()), installedExtensionsStore: {
  isLoaded: true, isEnabled: () => true,
  manifestFor: () => ({ id: 'vote', version: '1', contributes: { tabs: [{ name: 'poll', widget: { height: 240 } }] } }),
} }))

let harness: ReturnType<typeof createReactHarness>
afterEach(() => { harness?.cleanup(); fixture.read.mockReset(); fixture.claim.mockClear() })

it.each(['electron', 'phone'])('keeps glyph, text and loading through a pending original registry read on %s', async platform => {
  fixture.platform.kind = platform
  const widget = { v: 2 as const, app: 'vote', view: 'poll', text: 'Dinner', height: 240 }
  const message = { id: 'message', chat_id: 'chat', sender_user_id: 'sender', content: JSON.stringify(widget) }
  const resolved = { id: 'registered-widget', widget, senderId: 'sender' }
  let resolve!: (value: typeof resolved) => void, reject!: (error: Error) => void
  fixture.read.mockReturnValueOnce(new Promise<typeof resolved>(done => { resolve = done }))
  fixture.read.mockReturnValueOnce(new Promise<typeof resolved>((_done, fail) => { reject = fail }))
  harness = createReactHarness()
  // Ids of their own per case: an original read once this session shows at once when mounted again.
  const view = (id: string) => <div style={{ width: 400 }}><WidgetBubble message={{ ...message, id: `${platform}-${id}` }} /></div>
  await harness.render(view('message'))
  await until('the real original-message hook is waiting for the registry', () => fixture.read.mock.calls.length === 1)
  const frame = () => harness.container.querySelector<HTMLElement>('[data-widget-bubble] > div')!
  const pending = harness.container.querySelector<HTMLElement>('[data-widget-loading]')
  expect(pending).not.toBeNull()
  expect(pending!.querySelector('svg')).not.toBeNull()
  expect(pending!.textContent).toContain('Dinner')
  expect(pending!.textContent).toContain('message.reference.loading')
  expect(pending!.getBoundingClientRect().height).toBe(240)
  expect(frame().getBoundingClientRect().height).toBe(240)
  resolve(resolved)
  await until('the resolved original reaches the existing widget view', () => !!harness.container.querySelector('[data-widget-id="registered-widget"]'))
  expect(frame().getBoundingClientRect().height).toBe(240)
  await harness.render(view('other-message'))
  await until('the second registry read is pending', () => fixture.read.mock.calls.length === 2)
  expect(harness.container.querySelector('[data-widget-loading]')).not.toBeNull()
  reject(new Error('registry unavailable'))
  await until('the original read error is visible', () => !!harness.container.querySelector('[role="alert"]'))
  expect(harness.container.querySelector('[role="alert"]')!.textContent).toContain('registry unavailable')
  expect(harness.container.querySelector('[data-widget-loading]')).toBeNull()
  expect(frame().getBoundingClientRect().height).toBe(240)
})
