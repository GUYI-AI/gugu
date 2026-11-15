// @vitest-environment jsdom
// The assistant is an App (owner 11-06) and its entry is with the Apps (owner 11-12: 「放在 App 那块，哪怕是内置的也要放到下面」):
// no cell at the top of the rail; while the App is where the assistant lives (installed, on, trusted) it is the first App of
// the rail's App group, below the separator, with its own icon and its siblings' look. A click goes where the entry decision
// says; the assistant chat's unread is its dot. Otherwise nothing of it is on the rail.
import { act, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

const capability = vi.hoisted(() => ({ agentRuntime: true }))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, capabilities: { ...actual.platform.capabilities, get agentRuntime() { return capability.agentRuntime } } } }
})
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/snapshot-registry', () => ({
  snapshotRegistry: { register: vi.fn(() => () => undefined) },
}))

const { Sidebar } = await import('../../../../apps/desktop/src/components/Sidebar')
const { DevicesContext } = await import('../../../../apps/desktop/src/store/devicesContext')
const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state')
const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { installAssistantShellBridge, publishAssistantShell } = await import('../../../../apps/desktop/src/lib/assistantShellBridge')
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('../../../../apps/desktop/src/lib/appConversationSurfaceBridge')
const { ASSISTANT_APP_ID, installAssistantAppEntryBridge, publishAssistantAppWord } = await import('../../../../apps/desktop/src/lib/assistantEntry')

const OWNER = 'u1'
const DM = '33000000-0000-4000-8000-000000000003'
const ICON = 'data:image/png;base64,AAAA'
const auth = { id: OWNER, email: 'u@e.com', nickname: 'U' }
const assistant = { id: 'a1', display_name: '小咕', avatar: null }
const entry = (root: ParentNode) => root.querySelector<HTMLElement>(`[data-testid="${AUTOMATION_TEST_IDS.sidebarAssistantNav}"]`)
const badge = (root: ParentNode) => entry(root)!.querySelector('.gg-sidebar-badge')
const pinned = (root: ParentNode) => Array.from(root.querySelectorAll('[data-dock-app]')).map((node) => node.getAttribute('data-dock-app'))
const shell = (over: Record<string, unknown> = {}) => ({
  cloudAvailable: false, canHostHere: true, cloud: null, loadError: null, assistant: { ...assistant, created_at: null },
  assistantState: 'found' as const, ownerName: 'U', ownerId: OWNER, chatId: DM, home: null, setup: null, member: false, preparing: false, ...over,
})
const app = (id: string, name = id) => ({ id, name, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'today', title: name }] } })
const apps = (over: { disabled?: string[]; installed?: boolean; dock?: string[] } = {}) => installedExtensionsStore.applyList({
  extensions: [...over.installed === false ? [] : [app(ASSISTANT_APP_ID, 'Gugu')], app('notes')], invalid: [],
  icons: {}, appIcons: { [ASSISTANT_APP_ID]: ICON }, disabled: over.disabled ?? [], disclosure: {}, dock: over.dock ?? [ASSISTANT_APP_ID, 'notes'],
} as never)

async function renderRail(chats: { id: string; unread_count: number }[] = [], onTabChange = vi.fn(), activeTab: 'chats' | 'tasks' = 'chats') {
  const harness = createReactHarness()
  const devices = { devices: [], loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [], cloudComputer: { available: false, snapshot: null, loadError: null } }
  const node: ReactNode = createElement(DevicesContext.Provider, { value: devices as never }, createNode(Sidebar, { activeTab, onTabChange }))
  await renderWithAppProviders(harness, node, { auth, chat: { chats: chats as never } })
  return harness
}

beforeEach(() => {
  installAssistantShellBridge(); installAppConversationSurfaceBridge(); installAssistantAppEntryBridge()
  publishAssistantShell(shell())
  publishAssistantAppWord({ ownerId: OWNER, trusted: true })
  publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM })
  apps()
  appState.navigation.navigate('home')
})
afterEach(() => {
  capability.agentRuntime = true
  publishAssistantAppWord(null)
  publishAppConversationSurfaces({})
  publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, ownerId: null }))
  installedExtensionsStore.applyList({ extensions: [], invalid: [], icons: {}, disabled: [], disclosure: {}, dock: [] } as never)
})

describe('the assistant App is the first App of the rail\'s App group', () => {
  it('sits below the separator, first in the group, with its own icon; nothing is at the top of the rail', async () => {
    const harness = await renderRail()
    try {
      const item = entry(harness.container)!
      const group = harness.container.querySelector(`[data-testid="${AUTOMATION_TEST_IDS.sidebarDock}"]`)!
      // In the App group, below the separator after 「App」, and first there; the pinned Apps follow without it.
      expect(item.closest('.gg-sidebar-dock')).toBe(group)
      expect(group.querySelector('.gg-sidebar-item')).toBe(item)
      expect(group.previousElementSibling?.classList.contains('gg-sidebar-rail-sep')).toBe(true)
      expect(pinned(harness.container)).toEqual(['notes'])
      // Its own icon, the siblings' item look.
      expect(item.querySelector('img.gg-sidebar-app-icon')?.getAttribute('src')).toBe(ICON)
      expect(item.classList.contains('gg-sidebar-item')).toBe(true)
      expect(item.getAttribute('aria-label')).toBe('Gugu')
      // The rail starts with 「消息」: no assistant cell (or any slot) above it.
      const first = harness.container.querySelector('.gg-sidebar-primary button')
      expect(first?.getAttribute('data-testid')).toBe(AUTOMATION_TEST_IDS.sidebarMessagesNav)
      expect(harness.container.querySelector('.gg-sidebar-profile-slot')).toBeNull()
      expect(harness.container.querySelectorAll(`[data-testid="${AUTOMATION_TEST_IDS.sidebarAssistantNav}"]`)).toHaveLength(1)
    } finally { harness.cleanup() }
  })

  it('opens the App\'s own page through the entry decision, and is lit there, bound or not', async () => {
    const onTabChange = vi.fn()
    const harness = await renderRail([], onTabChange, 'tasks')
    try {
      await clickElement(entry(harness.container)!)
      expect(onTabChange).toHaveBeenCalledWith('tasks')
      expect(appState.navigation.currentViewId).toBe('app')
      expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
      expect(entry(harness.container)!.getAttribute('aria-current')).toBe('page')
      // Not bound any more (the person picked another chat, or withdrew a grant): still its page, still first in the group.
      await act(async () => publishAppConversationSurfaces({}))
      expect(entry(harness.container)!.getAttribute('aria-current')).toBe('page')
      expect(pinned(harness.container)).toEqual(['notes'])
    } finally { harness.cleanup() }
  })

  it('carries the assistant chat\'s unread as its dot, from the chat itself; none while no conversation is drawn beside the App', async () => {
    const harness = await renderRail([{ id: DM, unread_count: 3 }])
    try {
      expect(badge(harness.container)).not.toBeNull()
      // Opening the App reads nothing: the dot stays until the conversation itself is read.
      await clickElement(entry(harness.container)!)
      expect(badge(harness.container)).not.toBeNull()
      await act(async () => publishAppConversationSurfaces({}))
      expect(badge(harness.container)).toBeNull()
    } finally { harness.cleanup() }
  })
})

describe('without the App where the assistant lives, nothing of it is on the rail', () => {
  it.each([
    ['not installed', () => apps({ installed: false, dock: ['notes'] })],
    ['switched off', () => apps({ disabled: [ASSISTANT_APP_ID] })],
  ])('the App %s: no assistant item, nothing above 「消息」', async (_case, arrange) => {
    arrange()
    const harness = await renderRail()
    try {
      expect(entry(harness.container)).toBeNull()
      expect(harness.container.querySelector('.gg-sidebar-primary button')?.getAttribute('data-testid')).toBe(AUTOMATION_TEST_IDS.sidebarMessagesNav)
      expect(pinned(harness.container)).toEqual(['notes'])
    } finally { harness.cleanup() }
  })

  it('a copy main does not trust is an ordinary App: pinned as the person pinned it, no assistant item', async () => {
    publishAssistantAppWord({ ownerId: OWNER, trusted: false })
    const harness = await renderRail()
    try {
      expect(entry(harness.container)).toBeNull()
      expect(pinned(harness.container)).toEqual([ASSISTANT_APP_ID, 'notes'])
    } finally { harness.cleanup() }
  })

  it('no assistant yet and no App, or the web build without Apps: the rail has no assistant cell', async () => {
    publishAssistantAppWord(null)
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null }))
    apps({ installed: false, dock: [] })
    const desktop = await renderRail()
    try { expect(entry(desktop.container)).toBeNull() } finally { desktop.cleanup() }
    capability.agentRuntime = false
    publishAssistantAppWord({ ownerId: OWNER, trusted: true })
    apps()
    const web = await renderRail()
    try {
      expect(entry(web.container)).toBeNull()
      expect(web.container.querySelector('.gg-sidebar-primary button')?.getAttribute('data-testid')).toBe(AUTOMATION_TEST_IDS.sidebarMessagesNav)
    } finally { web.cleanup() }
  })
})
