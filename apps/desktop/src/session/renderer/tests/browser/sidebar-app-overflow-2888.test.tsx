import { afterEach, expect, it, vi } from 'vitest'
import { page, userEvent } from 'vitest/browser'
import { Sidebar } from '@/components/Sidebar'
import { UI_EVENTS } from '@/lib/uiEvents'
import { createReactHarness, renderWithAppProviders } from '../../../../../../../tests/support/testHarness'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@/i18n/registerMainCatalog'
import '@/styles/tokens.css'
import '@renderer/index.css'

const state = vi.hoisted(() => ({
  apps: [] as { extensionId: string; kind: string; name: string; iconDataUrl: null }[],
  open: vi.fn(),
}))
vi.mock('@/session/renderer/features/extensions/installed-extensions-store', () => ({
  InstalledExtensionsStore: class {}, WORKSPACE_APP_ID: 'workspace',
  installedExtensionsStore: {
    get dockedApps() { return state.apps }, get openableApps() { return state.apps },
    get dock() { return state.apps.map(app => app.extensionId) },
    manifestFor: () => undefined, updateCount: 0,
  },
}))
vi.mock('@/session/renderer/features/extensions/app-dock', () => ({
  pinToDock: vi.fn(), wireAppQuit: vi.fn(),
  openApp: state.open, appIsRunning: () => false, openAppInWindow: vi.fn(), quitApp: vi.fn(), setDock: vi.fn(), unpinFromDock: vi.fn(),
}))
vi.mock('@/session/renderer/lib/stores/app-state', () => ({
  sidebarStore: {},
  appState: { navigation: { currentViewId: 'apps', viewParamsStore: {}, navigate: vi.fn() } },
}))
vi.mock('@/lib/assistantEntry', () => ({
  openAssistantPageInApp: vi.fn(), readAssistantEntryTarget: () => ({ kind: 'chat' }), assistantAppUsable: () => false,
  ASSISTANT_APP_ID: 'assistant', useAssistantEntryTarget: () => ({ kind: 'chat' }),
  assistantEntryUnread: () => false, openAssistantEntry: vi.fn(),
}))
vi.mock('@/lib/productTour', () => ({
  TOUR_FILMS: [], TOUR_STEPS: [], resumableStep: () => null, useProductTourState: () => ({ data: null }),
}))
vi.mock('@/platform', async original => {
  const module = await original<typeof import('@/platform')>()
  return { ...module, platform: { ...module.platform, kind: 'electron',
    capabilities: { ...module.platform.capabilities, agentRuntime: true, appUpdates: true }, updateState: async () => null,
  } }
})

let harness: ReturnType<typeof createReactHarness>
afterEach(() => {
  harness?.cleanup()
  state.open.mockClear()
  delete document.documentElement.dataset.platform
  delete document.documentElement.dataset.theme
  document.body.style.margin = ''
})
const visibleIds = () => [...harness.container.querySelectorAll<HTMLElement>('[data-dock-app]')].map(node => node.dataset.dockApp)
async function mount(count: number, height: number, host = 'mac') {
  await page.viewport(1000, height)
  document.documentElement.dataset.platform = host
  document.documentElement.dataset.theme = 'dark'
  document.body.style.margin = '0'
  state.apps = Array.from({ length: count }, (_, index) => ({ extensionId: `app-${index + 1}`, kind: `app-kind-${index + 1}`, name: `App ${index + 1}`, iconDataUrl: null }))
  harness = createReactHarness()
  harness.container.style.cssText = 'display:flex;width:100vw;height:100vh'
  const navigate = vi.fn()
  await renderWithAppProviders(harness, <Sidebar activeTab="tasks" onTabChange={navigate} />)
  await until('the real dock has a measured row', () => harness.container.querySelector('.gg-sidebar-dock .gg-sidebar-item')!.getBoundingClientRect().height === 40)
  return navigate
}
function assertFooterVisible() {
  const rail = harness.container.querySelector('.gg-sidebar-rail')!
  const gear = harness.container.querySelector<HTMLElement>('[data-testid="sidebar-settings-nav"]')!
  const footer = gear.closest('.gg-sidebar-bottom')!
  const rect = gear.getBoundingClientRect()
  expect(rect.height).toBe(40)
  expect(rect.top).toBeGreaterThanOrEqual(rail.getBoundingClientRect().top)
  expect(rect.bottom).toBeLessThanOrEqual(innerHeight)
  expect(footer.getBoundingClientRect().bottom).toBeLessThanOrEqual(rail.getBoundingClientRect().bottom)
  expect((rail as HTMLElement).scrollHeight).toBe((rail as HTMLElement).clientHeight)
  expect(gear.closest('.gg-sidebar-primary')).toBeNull()
}

for (const height of [600, 900]) for (const host of ['mac', 'win']) {
  it(`keeps Settings visible and opens the last overflow App at ${height}px (${host})`, async () => {
    const navigate = await mount(32, height, host)
    await until('More and the visible prefix settle', () => visibleIds().length > 0 && visibleIds().length < 32)
    assertFooterVisible()
    const prefix = visibleIds()
    expect(prefix).toEqual(state.apps.slice(0, prefix.length).map(app => app.extensionId))
    const more = page.getByTestId('sidebar-more-apps')
    await userEvent.click(more)
    await until('the real menu is open', () => !!document.querySelector('[role="menu"]'))
    const rows = [...document.querySelectorAll<HTMLElement>('[role="menu"] [role="menuitem"]')]
    expect(rows.map(row => row.textContent)).toEqual(state.apps.slice(prefix.length).map(app => app.name))
    await userEvent.click(page.getByRole('menuitem', { name: 'App 32', exact: true }))
    expect(state.open).toHaveBeenCalledWith('app-32')
    expect(navigate).toHaveBeenCalledWith('tasks')
    assertFooterVisible()
    await userEvent.click(page.getByTestId('sidebar-settings-nav'))
    expect(navigate).toHaveBeenCalledWith('settings')
  })
}
it('reallocates when the window shrinks or an update entry occupies footer space', async () => {
  await mount(32, 900)
  await until('initial prefix', () => visibleIds().length > 0)
  const tall = visibleIds().length
  await page.viewport(1000, 600)
  await until('short prefix', () => visibleIds().length < tall)
  const short = visibleIds().length
  window.dispatchEvent(new CustomEvent(UI_EVENTS.updateStatus, { detail: { revision: 1, status: 'downloading', percent: 20 } }))
  await until('update entry reduces the App budget', () => !!document.querySelector('.gg-update-rail') && visibleIds().length < short)
  assertFooterVisible()
  await page.viewport(1000, 1100)
  await until('growing space returns Apps', () => visibleIds().length > tall)
  assertFooterVisible()
})
it('does not show More for a fitting list and keeps keyboard dismissal focus on More after overflow', async () => {
  await mount(3, 900)
  await until('all three fit', () => visibleIds().length === 3)
  expect(harness.container.querySelector('[data-testid="sidebar-more-apps"]')).toBeNull()
  harness.cleanup()
  await mount(32, 600)
  const trigger = harness.container.querySelector<HTMLElement>('[data-testid="sidebar-more-apps"]')!
  trigger.focus()
  await userEvent.keyboard('{Enter}')
  await until('keyboard opened More', () => !!document.querySelector('[role="menu"]'))
  await userEvent.keyboard('{Escape}')
  await until('focus returns to More', () => document.activeElement === trigger && !document.querySelector('[role="menu"]'))
  assertFooterVisible()
})
