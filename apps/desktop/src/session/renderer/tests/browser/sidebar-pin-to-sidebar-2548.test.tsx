/**
 * #2548 固定到左侧栏: the existing session row menu offers it right after 置顶, for a top-level session only, and
 * clicking it writes through the row's own session store.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { until } from '../../../../../../../tests/support/awaitCondition'

const state = vi.hoisted(() => ({
  isPinnedToSidebar: false,
  parentSessionId: null as string | null,
  setSessionPinnedToSidebar: vi.fn((_sessionId: string, _pinned: boolean) => Promise.resolve()),
}))

vi.mock('@renderer/features/settings/use-app-settings-key', () => ({
  useAppSettingsKey: () => ({ value: {} }),
}))
vi.mock('@renderer/features/sessions/stores/session-registry', () => ({
  sessionRegistry: {
    get: () => ({
      setSessionPinned: () => Promise.resolve(),
      setSessionPinnedToSidebar: state.setSessionPinnedToSidebar,
      sessions: {
        get: () => ({
          data: {
            providerId: 'claude',
            title: '定价页搭建',
            isPinned: true,
            isPinnedToSidebar: state.isPinnedToSidebar,
            parentSessionId: state.parentSessionId,
            lastInteractedAt: new Date(Date.now() - 22 * 60_000).toISOString(),
          },
          status: 'idle',
        }),
      },
    }),
  },
}))
vi.mock('@renderer/lib/stores/app-state', () => ({
  appState: {
    projects: { projects: new Map() },
    navigation: { currentViewId: 'session', viewParamsStore: { session: { projectId: 'proj-1', sessionId: 'other' } } },
  },
  sidebarStore: {
    remoteSession: () => undefined,
    agentNameOnHoverEnabled: false,
    expandedProjectIds: new Set<string>(),
    launchedByAssistant: () => false,
  },
}))
vi.mock('@renderer/features/extensions/installed-extensions-store', () => ({
  installedExtensionsStore: { isLoaded: true, manifestFor: () => undefined, appName: () => undefined },
  InstalledExtensionsStore: class {},
}))
vi.mock('@renderer/features/sessions/archive-session-flow', () => ({
  requestArchiveSession: () => undefined,
  archiveSessionNow: () => undefined,
  confirmArchive: () => undefined,
}))
vi.mock('@renderer/features/sessions/open-session-in-session', () => ({
  openSessionInSessionWhenReady: () => undefined,
}))
vi.mock('@renderer/lib/layout/navigation-provider', () => ({
  useNavigate: () => ({ navigate: () => {} }),
  useParams: () => ({ params: {} }),
  useWorkspaceSlots: () => ({ currentView: 'task' }),
}))

import { SidebarSessionItem } from '@renderer/features/sidebar/sidebar-session-item'
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider'
import '@/styles/tokens.css'
import '@renderer/index.css'

let root: Root
let host: HTMLDivElement

beforeEach(() => {
  Object.assign(state, { isPinnedToSidebar: false, parentSessionId: null })
  state.setSessionPinnedToSidebar.mockClear()
  host = document.createElement('div')
  host.className = 'gugu-skin emlight'
  host.style.width = '260px'
  document.body.append(host)
  root = createRoot(host)
})

afterEach(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  root.unmount()
  host.remove()
})

/** Mount the row, right-click it, return the menu item labels in order. */
async function openMenu(): Promise<HTMLElement[]> {
  root.render(
    <QueryClientProvider client={new QueryClient()}>
      <SessionLocalizationProvider>
        <SidebarSessionItem projectId="proj-1" sessionId="conv-1" />
      </SessionLocalizationProvider>
    </QueryClientProvider>
  )
  await until('sidebar row mounted', () => host.querySelector('[data-session-id="conv-1"]') !== null)
  host.querySelector<HTMLElement>('[data-session-id="conv-1"]')!.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 40 })
  )
  await until('context menu items render', () => document.querySelectorAll('[role="menuitem"]').length > 0)
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]'))
}
const labels = (items: HTMLElement[]) => items.map((item) => item.textContent?.trim() ?? '')
const sidebarItem = (items: HTMLElement[]) => items.find((item) => /左侧栏|sidebar/i.test(item.textContent ?? ''))

it('固定到左侧栏 sits right after 置顶, and clicking it pins this session', async () => {
  const items = await openMenu()
  const shown = labels(items)
  const pinAt = shown.findIndex((label) => /取消置顶|^Unpin$/.test(label))
  expect(pinAt, `menu: ${shown.join(' | ')}`).toBeGreaterThanOrEqual(0)
  expect(shown[pinAt + 1], `menu: ${shown.join(' | ')}`).toMatch(/^(固定到左侧栏|Pin to sidebar)$/)
  await page.screenshot({ path: '__screenshots__/sidebar-pin-to-sidebar-2548/menu-pin.png' })

  await userEvent.click(sidebarItem(items)!)
  await until('pin written', () => state.setSessionPinnedToSidebar.mock.calls.length > 0)
  expect(state.setSessionPinnedToSidebar.mock.calls).toEqual([['conv-1', true]])
})

it('already pinned: offers 取消固定到左侧栏, which unpins', async () => {
  state.isPinnedToSidebar = true
  const items = await openMenu()
  expect(labels(items)).toContainEqual(expect.stringMatching(/^(取消固定到左侧栏|Unpin from sidebar)$/))
  await page.screenshot({ path: '__screenshots__/sidebar-pin-to-sidebar-2548/menu-unpin.png' })

  await userEvent.click(sidebarItem(items)!)
  await until('unpin written', () => state.setSessionPinnedToSidebar.mock.calls.length > 0)
  expect(state.setSessionPinnedToSidebar.mock.calls).toEqual([['conv-1', false]])
})

it('a child session never offers it', async () => {
  state.parentSessionId = 'parent-1'
  const items = await openMenu()
  expect(sidebarItem(items), `menu: ${labels(items).join(' | ')}`).toBeUndefined()
})
