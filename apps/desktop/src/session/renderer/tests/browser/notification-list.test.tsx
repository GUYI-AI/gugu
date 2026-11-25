import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { ChatListPanel } from '@/components/ChatListPanel'
import { NeedsYouHost } from '@/components/needsYou/NeedsYouHost'
import { SidebarOneListFoot } from '@renderer/features/sidebar/sidebar-one-list-chrome'
import { installShellSlots } from '@/lib/shellSlots'
import { i18n } from '@/i18n'
import { chat, createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMessagingCatalog'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'
import '@/mobile/phone-shell.css'

const state = vi.hoisted(() => ({ mobile: false }))
const markSeen = vi.hoisted(() => vi.fn(async () => {}))
const followLink = vi.hoisted(() => vi.fn())
vi.mock('@/lib/guguLinks', async original => ({ ...await original<object>(), followLink }))
vi.mock('@gugu/core/cloud/config', async original => ({ ...await original<object>(), getSupabaseUrl: () => 'http://supabase.test.local', getSupabaseAnonKey: () => 'test-anon-key' }))
vi.mock('@/platform', async original => {
  const module = await original<typeof import('@/platform')>()
  return { ...module, platform: { ...module.platform, get kind() { return state.mobile ? 'capacitor' : 'electron' } } }
})
vi.mock('@/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [] }) }))
vi.mock('@/hooks/useAgentDisplayStatus', async original => ({ ...await original<object>(), useAgentDisplayStatuses: () => ({}) }))
vi.mock('@/components/AddFriendSearch', () => ({ AddFriendSearch: () => null }))
vi.mock('@renderer/features/settings/use-app-settings-key', async () => { const { fakeAppSettings } = await import('../../../../../../../tests/support/appSettingsDouble'); return { useAppSettingsKey: () => fakeAppSettings({}) } })
vi.mock('@renderer/lib/layout/layout-provider', () => ({ sidebarRailTextOpacity: () => 1, useSidebarProgressFollow: () => ({ current: null }), useLeftRailLayout: () => false, useWorkspaceLayoutContext: () => ({ isLeftOpen: true, toggleLeft: vi.fn() }) }))
// The one list's head (the desktop bell's place) reads where the task page is; the search box beside the bell is not this case's.
vi.mock('@renderer/lib/layout/navigation-provider', () => ({ useNavigate: () => ({ navigate: () => {} }), useWorkspaceSlots: () => ({ currentView: 'home' }), isCurrentView: (current: string, view: string) => current === view }))
vi.mock('@renderer/features/sidebar/sidebar-search-trigger', () => ({ SidebarSearchTrigger: () => null }))
// The unit integration covers the real directory. These layout cases keep all 100 pending tasks stable.
vi.mock('@/components/needsYou/useNeedsYouTasks', () => ({
  markNeedsYouTaskSeen: markSeen,
  useNeedsYouTasks: () => ({ attention: 'approval', error: null, count: 100, tasks: Array.from({ length: 100 }, (_, index) => ({
    deviceId: 'host', machine: 'Host', local: false, phoneHost: false,
    session: { conversationId: `task-${index}`, title: `Task ${index}`, status: { status: 'needs_user', detail: 'approval' }, agentStatus: 'needs_user', unseen: true },
  })) }),
}))

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  vi.clearAllMocks()
  await i18n.changeLanguage('en-US')
  delete (window as unknown as Record<string, unknown>).__GUGU_SIDEBAR_NOTIFICATIONS_OPEN__
  installShellSlots()
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup() })

it('the phone\'s list header keeps its bell/badge inside the pane and retains chat scroll', async () => {
  state.mobile = true
  const width = 320
  await page.viewport(width, 844)
  harness.container.style.cssText = `width:${width}px;height:700px;display:flex`
  harness.container.setAttribute('data-phone-shell', '')
  await renderWithAppProviders(harness, <><ChatListPanel mobile /><NeedsYouHost /></>, {
    chat: { chats: Array.from({ length: 40 }, (_, index) => chat({ id: `chat-${index}`, kind: 'group', name: `Group ${index}` })) },
  })
  const bell = harness.container.querySelector<HTMLButtonElement>('[data-testid="notification-toggle"]')!
  await until('the bell and count are laid out', () => bell?.getBoundingClientRect().width > 0)
  const badge = harness.container.querySelector<HTMLElement>('[data-testid="notification-count"]')!
  const header = bell.closest<HTMLElement>('[data-slot="pane-header"]')!
  const headerBox = header.getBoundingClientRect()
  const badgeBox = badge.getBoundingClientRect()
  expect(badge.textContent).toBe('99+')
  expect(badgeBox.left).toBeGreaterThanOrEqual(headerBox.left)
  expect(badgeBox.right).toBeLessThanOrEqual(headerBox.right)
  expect(badgeBox.top).toBeGreaterThanOrEqual(headerBox.top)
  expect(getComputedStyle(badge).backgroundColor).not.toBe('rgba(0, 0, 0, 0)')
  const original = harness.container.querySelector<HTMLElement>('[data-notification-original-list]')!
  const scroller = [...original.querySelectorAll<HTMLElement>('*')].find(node => node.scrollHeight > node.clientHeight && getComputedStyle(node).overflowY === 'auto')!
  expect(scroller).toBeDefined()
  scroller.scrollTop = 87
  const height = scroller.clientHeight
  await userEvent.click(bell)
  await until('the global notification list is visible', () => !!harness.container.querySelector('[data-testid="notification-list"]'))
  expect(harness.container.querySelector('[data-notification-original-list]')).toBe(original)
  // Both ways back: the list's own worded button, and the bell again.
  await userEvent.click(harness.container.querySelector<HTMLButtonElement>('[data-testid="notification-back"]')!)
  await until('the back button closes the list', () => bell.getAttribute('aria-pressed') === 'false' && !harness.container.querySelector('[data-testid="notification-list"]'))
  await userEvent.click(bell)
  await until('the list opens again', () => !!harness.container.querySelector('[data-testid="notification-list"]'))
  await userEvent.click(bell)
  await until('the original list has its viewport again', () => getComputedStyle(original).contentVisibility !== 'hidden')
  expect(scroller.clientHeight).toBe(height)
  expect(scroller.scrollTop).toBe(87)
})

it('the desktop sidebar\'s foot keeps the bell badge inside the window', async () => {
  state.mobile = false
  await page.viewport(1000, 800)
  harness.container.style.cssText = 'position:relative;width:1000px;height:700px'
  await renderWithAppProviders(harness, <><div className="gugu-skin" style={{ width: 280 }}><SidebarOneListFoot /></div><NeedsYouHost /></>)
  const badge = harness.container.querySelector<HTMLElement>('[data-testid="notification-count"]')!
  await until('the workspace badge is laid out', () => badge?.getBoundingClientRect().width > 0)
  const box = badge.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(0)
  expect(box.top).toBeGreaterThanOrEqual(0)
  expect(box.right).toBeLessThanOrEqual(1000)
})

it('the desktop bell pops its list beside itself, a menu\'s way: a row acts and closes it, so do Esc, a click outside and the bell', async () => {
  state.mobile = false
  await page.viewport(1000, 800)
  harness.container.style.cssText = 'position:relative;width:1000px;height:700px;display:flex;align-items:flex-end'
  await renderWithAppProviders(harness, <><div className="gugu-skin" style={{ width: 280 }} data-testid="sidebar-stand-in"><SidebarOneListFoot /></div><NeedsYouHost /></>)
  const bell = harness.container.querySelector<HTMLButtonElement>('[data-testid="notification-toggle"]')!
  await until('the bell is laid out', () => bell?.getBoundingClientRect().width > 0)
  const popover = () => document.querySelector<HTMLElement>('[data-testid="notification-popover"]')
  const shown = () => !!popover() && !popover()!.hasAttribute('data-ending-style')
  await userEvent.click(bell)
  await until('the list pops up', () => shown() && popover()!.getBoundingClientRect().height > 0)
  // Beside the bell, its foot on the bell's row; the sidebar is not taken over.
  const box = popover()!.getBoundingClientRect(), at = bell.getBoundingClientRect()
  expect(box.left).toBeGreaterThanOrEqual(at.right)
  expect(Math.abs(box.bottom - at.bottom)).toBeLessThanOrEqual(8)
  expect(box.bottom).toBeLessThanOrEqual(800)
  expect(harness.container.querySelector('[data-testid="sidebar-stand-in"]')!.contains(popover())).toBe(false)
  expect(popover()!.querySelectorAll('[data-session-line]')).toHaveLength(100)
  await userEvent.click(popover()!.querySelectorAll<HTMLElement>('[data-session-line]')[1])
  expect(followLink).toHaveBeenCalledExactlyOnceWith({ kind: 'session', sessionId: 'task-1', deviceId: 'host' })
  await until('opening a task closes the list', () => !shown())
  await userEvent.click(bell)
  await until('it opens again', () => shown())
  await userEvent.keyboard('{Escape}')
  await until('Esc closes it', () => !shown())
  await userEvent.click(bell)
  await until('and again', () => shown())
  await userEvent.click(document.body, { position: { x: 900, y: 20 } })
  await until('a click outside closes it', () => !shown())
  await userEvent.click(bell)
  await until('once more', () => shown())
  await userEvent.click(bell)
  await until('the bell closes it', () => !shown())
})
