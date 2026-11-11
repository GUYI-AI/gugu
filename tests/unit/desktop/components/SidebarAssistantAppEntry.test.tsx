// @vitest-environment jsdom
// Entry switch: the left rail's top cell keeps its place, look and states, and opens the trusted assistant App beside its
// conversation once the host has bound it — the built-in page otherwise. The App is not drawn a second time in the dock.
import { act, createElement, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AUTOMATION_TEST_IDS } from '../../../../apps/desktop/src/lib/automationDom'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: { ...actual.platform, capabilities: { ...actual.platform.capabilities, agentRuntime: true } } }
})
vi.mock('../../../../apps/desktop/src/session/renderer/lib/stores/snapshot-registry', () => ({
  snapshotRegistry: { register: vi.fn(() => () => undefined) },
}))
const mine = vi.hoisted(() => ({ value: { contact: null as null | { id: string; display_name: string; avatar: string | null }, agentId: null as string | null, loading: false, error: null } }))
vi.mock('../../../../apps/desktop/src/lib/myAssistant', () => ({ useMyAssistantContact: () => mine.value }))

const { Sidebar } = await import('../../../../apps/desktop/src/components/Sidebar')
const { DevicesContext } = await import('../../../../apps/desktop/src/store/devicesContext')
const { appState } = await import('../../../../apps/desktop/src/session/renderer/lib/stores/app-state')
const { installedExtensionsStore } = await import('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store')
const { installAssistantShellBridge, publishAssistantShell } = await import('../../../../apps/desktop/src/lib/assistantShellBridge')
const { installAppConversationSurfaceBridge, publishAppConversationSurfaces } = await import('../../../../apps/desktop/src/lib/appConversationSurfaceBridge')
const { ASSISTANT_APP_ID, installAssistantAppEntryBridge, publishAssistantAppWord } = await import('../../../../apps/desktop/src/lib/assistantEntry')

const OWNER = 'u1'
const DM = '33000000-0000-4000-8000-000000000003'
const auth = { id: OWNER, email: 'u@e.com', nickname: 'U' }
const assistant = { id: 'a1', display_name: '小咕', avatar: null }
const byTestId = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-testid="${id}"]`)
const top = (root: ParentNode) => byTestId(root, AUTOMATION_TEST_IDS.sidebarAssistantNav)!
const badge = (root: ParentNode) => top(root).querySelector('.gg-sidebar-badge')
const shell = (over: Record<string, unknown> = {}) => ({
  cloudAvailable: false, canHostHere: true, cloud: null, loadError: null, assistant: { ...assistant, created_at: null },
  assistantState: 'found' as const, ownerName: 'U', ownerId: OWNER, chatId: DM, home: null, setup: null, member: false, preparing: false, ...over,
})
const app = (id: string) => ({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'today', title: id }] } })

async function renderRail(chats: { id: string; unread_count: number }[] = [], onTabChange = vi.fn(), activeTab: 'chats' | 'tasks' = 'chats') {
  const harness = createReactHarness()
  const devices = { devices: [], loading: false, error: null, refresh: async () => {}, rename: async () => {}, remove: async () => {}, listBoundAgents: async () => [], cloudComputer: { available: false, snapshot: null, loadError: null } }
  const node: ReactNode = createElement(DevicesContext.Provider, { value: devices as never }, createNode(Sidebar, { activeTab, onTabChange }))
  await renderWithAppProviders(harness, node, { auth, chat: { chats: chats as never } })
  return harness
}

beforeEach(() => {
  installAssistantShellBridge(); installAppConversationSurfaceBridge(); installAssistantAppEntryBridge()
  mine.value = { contact: assistant, agentId: assistant.id, loading: false, error: null }
  publishAssistantShell(shell())
  publishAssistantAppWord({ ownerId: OWNER, trusted: true })
  publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM })
  installedExtensionsStore.applyList({ extensions: [app(ASSISTANT_APP_ID), app('notes')], invalid: [], icons: {}, disabled: [], disclosure: {}, dock: [ASSISTANT_APP_ID, 'notes'] } as never)
  appState.navigation.navigate('home')
})
afterEach(() => {
  publishAssistantAppWord(null)
  publishAppConversationSurfaces({})
  publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, ownerId: null }))
  installedExtensionsStore.applyList({ extensions: [], invalid: [], icons: {}, disabled: [], disclosure: {}, dock: [] } as never)
})

describe('the top cell opens the assistant App once the host bound it', () => {
  it('opens the App\'s own page, is lit there, and the App is not a second icon in the dock', async () => {
    const onTabChange = vi.fn()
    const harness = await renderRail([], onTabChange, 'tasks')
    try {
      expect(top(harness.container).getAttribute('data-entry')).toBe('found')
      expect(top(harness.container).getAttribute('aria-label')).toBe('小咕')
      const dock = () => Array.from(harness.container.querySelectorAll('[data-dock-app]')).map((node) => node.getAttribute('data-dock-app'))
      expect(dock()).toEqual(['notes'])
      await clickElement(top(harness.container))
      expect(onTabChange).toHaveBeenCalledWith('tasks')
      expect(appState.navigation.currentViewId).toBe('app')
      expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
      expect(top(harness.container).getAttribute('aria-current')).toBe('page')
      // Not bound any more (the person picked another chat, or withdrew a grant): still its page, still the top cell.
      await act(async () => publishAppConversationSurfaces({}))
      expect(dock()).toEqual(['notes'])
      expect(top(harness.container).getAttribute('aria-current')).toBe('page')
    } finally { harness.cleanup() }
  })

  it('opens the assistant\'s chat as any chat when the App is not usable here (main does not trust it, or it is off), the dock as pinned', async () => {
    const opened: unknown[] = []
    const onLink = (event: Event) => { event.preventDefault(); opened.push((event as CustomEvent<{ target: unknown }>).detail.target) }
    window.addEventListener('gugu:open-link-target', onLink)
    publishAssistantAppWord({ ownerId: OWNER, trusted: false })
    const harness = await renderRail()
    try {
      const dock = () => Array.from(harness.container.querySelectorAll('[data-dock-app]')).map((node) => node.getAttribute('data-dock-app'))
      expect(dock()).toEqual([ASSISTANT_APP_ID, 'notes'])
      await clickElement(top(harness.container))
      expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
      expect(appState.navigation.currentViewId).toBe('home')
    } finally { harness.cleanup(); window.removeEventListener('gugu:open-link-target', onLink) }
  })

  it('shows the assistant chat\'s unread as its dot, from the chat itself; none while no conversation is drawn beside the App', async () => {
    const harness = await renderRail([{ id: DM, unread_count: 3 }])
    try {
      expect(badge(harness.container)).not.toBeNull()
      // Opening the App reads nothing: the dot stays until the conversation itself is read.
      await clickElement(top(harness.container))
      expect(badge(harness.container)).not.toBeNull()
      await act(async () => publishAppConversationSurfaces({}))
      expect(badge(harness.container)).toBeNull()
    } finally { harness.cleanup() }
  })

  it('shows its existing preparing state while the ensure step puts the App in (the assistant waits for its rules)', async () => {
    publishAppConversationSurfaces({})
    publishAssistantAppWord({ ownerId: OWNER, trusted: false })
    publishAssistantShell(shell({ rulesPending: true }))
    const harness = await renderRail()
    try {
      expect(top(harness.container).getAttribute('data-entry')).toBe('preparing')
      await act(async () => {
        publishAssistantShell(shell({ rulesPending: false }))
        publishAssistantAppWord({ ownerId: OWNER, trusted: true })
        publishAppConversationSurfaces({ [ASSISTANT_APP_ID]: DM })
      })
      expect(top(harness.container).getAttribute('data-entry')).toBe('found')
    } finally { harness.cleanup() }
  })

  it('keeps the states of a person without an assistant: faded with a plus; the App\'s own page, or setup when there is no App', async () => {
    const settings: unknown[] = []
    const onSettings = (event: Event) => settings.push((event as CustomEvent).detail)
    window.addEventListener('__open_settings', onSettings)
    mine.value = { contact: null, agentId: null, loading: false, error: null }
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null }))
    const harness = await renderRail()
    try {
      expect(top(harness.container).getAttribute('data-entry')).toBe('none')
      expect(top(harness.container).querySelector('.gg-sidebar-assistant-mark')).not.toBeNull()
      await clickElement(top(harness.container))
      expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
      await act(async () => appState.navigation.navigate('home'))
      await act(async () => publishAssistantAppWord(null))
      await clickElement(top(harness.container))
      expect(settings).toEqual([{ section: 'assistant' }])
      expect(appState.navigation.currentViewId).toBe('home')
    } finally { harness.cleanup(); window.removeEventListener('__open_settings', onSettings) }
  })
})
