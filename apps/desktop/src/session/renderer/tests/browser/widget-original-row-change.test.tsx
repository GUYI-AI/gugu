import { useEffect, useRef } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { WidgetBubble } from '@/components/chat/WidgetBubble'
import { createReactHarness } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import { followRendererSession } from '@/lib/replica'

const fixture = vi.hoisted(() => ({ mounts: 0 }))
vi.mock('@/platform', async original => ({ ...(await original<object>()), platform: { kind: 'electron' } }))
vi.mock('react-i18next', async original => ({ ...(await original<object>()), useTranslation: () => ({ t: (key: string) => key }) }))
vi.mock('@/store/auth', async original => ({ ...(await original<object>()), useAuth: () => ({ user: { id: 'reader' } }) }))
vi.mock('@/store/theme', async original => ({ ...(await original<object>()), useTheme: () => ({ theme: 'light' }) }))
vi.mock('@/store/chatContext', async original => ({ ...(await original<object>()), useChatStore: () => ({ subscribeAccountRevision: () => () => {} }) }))
vi.mock('@/lib/widgetRegistry', async original => ({ ...(await original<object>()), widgetForOriginal: async () => ({ id: 'widget', widget: { v: 2, app: 'vote', view: 'poll', text: 'Dinner', height: 240 }, senderId: 'sender' }) }))
vi.mock('@/lib/widgetSnapshots', async original => ({ ...(await original<object>()), widgetSnapshots: { read: async () => null, capture: () => ({ accountId: 'reader', generation: 0 }) } }))
vi.mock('@/components/appSlot/appsHere', () => ({ appsHere: {} }))
vi.mock('@/components/chat/useConversationVisibility', () => ({ useConversationVisibility: () => ({ ref: useRef(null), shown: true }) }))
vi.mock('@/components/chat/useWidgetPresence', () => ({ useWidgetPresence: () => ({ active: true, preload: false, locate: () => {} }) }))
// The App's page: counts how often it is started.
vi.mock('@renderer/features/extensions/extension-view-layer', () => ({ ExtensionPage: () => { useEffect(() => { fixture.mounts++ }, []); return <div data-page /> } }))
vi.mock('@/session/renderer/features/extensions/installed-extensions', async original => {
  const installed = { isLoaded: true, isEnabled: () => true,
    manifestFor: () => ({ id: 'vote', version: '1', contributes: { tabs: [{ name: 'poll', widget: { height: 240 } }] } }) }
  return { ...(await original<object>()), useInstalledApps: () => ({ state: 'value', stale: false, error: null, value: installed }),
    peekInstalledApps: () => installed, peekInstalledAppsTracked: () => installed, fetchInstalledApps: async () => installed }
})

let harness: ReturnType<typeof createReactHarness>
afterEach(() => harness?.cleanup())

// The chat hands the bubble its whole row; receipts and delivery on it change (the reader's own next send reads the
// message, say) while the widget is the same: its page keeps running.
it('keeps a widget page running when its message row changes in receipts or delivery', async () => {
  followRendererSession('SIGNED_IN', 'reader')
  harness = createReactHarness()
  const row = { id: 'message', chat_id: 'chat', sender_user_id: 'sender', content: JSON.stringify({ v: 2, app: 'vote', view: 'poll', text: 'Dinner', height: 240 }),
    readers: [] as string[], delivered: false }
  const view = (message: typeof row) => <div style={{ width: 400 }}><WidgetBubble message={message} /></div>
  await harness.render(view(row))
  await until('the page starts', () => !!harness.container.querySelector('[data-page]'))
  const page = harness.container.querySelector('[data-page]')
  await harness.render(view({ ...row, readers: ['reader'], delivered: true }))
  await new Promise(resolve => setTimeout(resolve, 200))
  expect(harness.container.querySelector('[data-page]')).toBe(page)
  expect(fixture.mounts).toBe(1)
})
