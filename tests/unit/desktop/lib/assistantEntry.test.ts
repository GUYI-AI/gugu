// @vitest-environment jsdom
// Entry switch: the one decision every entry to the personal assistant asks — the trusted assistant App beside its
// conversation, or the built-in page — and what opening the App does (and does not do).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ASSISTANT_APP_ID,
  assistantEntryUnread,
  decideAssistantEntry,
  installAssistantAppEntryBridge,
  openAssistantEntry,
  openAssistantPageInApp,
  openAssistantTaskInApp,
  publishAssistantAppWord,
  readAssistantEntryTarget,
} from '../../../../apps/desktop/src/lib/assistantEntry'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { requestAssistantSettingsSection, takeAssistantSettingsSection } from '../../../../apps/desktop/src/lib/assistantSettingsSection'
import { appConversationSlotKey, installAppConversationSurfaceBridge, publishAppConversationSurfaces } from '../../../../apps/desktop/src/lib/appConversationSurfaceBridge'
import { appState } from '../../../../apps/desktop/src/session/renderer/lib/stores/app-state'
import { appHostLayerSlotKey, installAppHostLayerBridge, readAppHostLayerBridge, resetAppHostLayersForTest, setAppHostLayerAccount } from '../../../../apps/desktop/src/lib/appHostLayerBridge'
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { appConversationPanelCollapsed, setAppConversationPanelCollapsed } from '../../../../apps/desktop/src/session/renderer/features/apps/app-conversation-panel'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

// Where Apps are (a task host): the no-App 开通 opens the Apps page there; the web build has none.
const host = vi.hoisted(() => ({ sessionHost: true }))
vi.mock('../../../../apps/desktop/src/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/platform')>()
  return { ...actual, platform: new Proxy(actual.platform, { get: (target, key) => (key === 'capabilities' ? { ...target.capabilities, sessionHost: host.sessionHost } : Reflect.get(target, key)) }) }
})

const OWNER = '11000000-0000-4000-8000-000000000001'
const OTHER = '22000000-0000-4000-8000-000000000002'
const DM = '33000000-0000-4000-8000-000000000003'

const shell = (over: Partial<AssistantShellSnapshot> = {}): AssistantShellSnapshot => ({
  cloudAvailable: false, canHostHere: true, cloud: null, loadError: null,
  assistant: { id: 'assistant', display_name: '咕咕', avatar: null, created_at: null },
  assistantState: 'found', ownerName: 'U', ownerId: OWNER, chatId: DM, home: null, setup: null, member: false, preparing: false, ...over,
})
const word = { ownerId: OWNER, trusted: true }
const bound = { [ASSISTANT_APP_ID]: DM }
const APP = { kind: 'app', extensionId: ASSISTANT_APP_ID, chatId: DM }
const decide = (over: Partial<Parameters<typeof decideAssistantEntry>[0]> = {}) =>
  decideAssistantEntry({ shell: shell(), word, surfaces: bound, appEnabled: true, ...over })
const appManifest = (actions: string[] = ['unread', 'surface']) => ({ id: ASSISTANT_APP_ID, name: 'A', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  permissions: { capabilities: ['chat:unread'], bindings: [{ name: 'main', kind: 'conversation', actions }] }, contributes: { tabs: [{ name: 'today', title: 'A' }] } })
const installApp = (actions?: string[], disabled: string[] = []) =>
  installedExtensionsStore.applyList({ extensions: [appManifest(actions)], invalid: [], icons: {}, disabled, disclosure: {}, dock: [] } as never)
const noApps = () => installedExtensionsStore.applyList({ extensions: [], invalid: [], icons: {}, disabled: [], disclosure: {}, dock: [] } as never)

describe('decideAssistantEntry', () => {
  it('goes to the App when it is the trusted one for this account and on, its conversation the one beside it', () => {
    expect(decide()).toEqual(APP)
  })

  // The App is the assistant's page on every machine the person opens it from, wherever the assistant lives.
  it.each([
    ['on this computer', { kind: 'computer', deviceId: 'this', thisDevice: true, label: null, online: true, known: true, hostKind: 'desktop' }],
    ['on another computer', { kind: 'computer', deviceId: 'mac-2', thisDevice: false, label: 'Mac', online: true, known: true, hostKind: 'desktop' }],
    ['on another computer that is offline', { kind: 'computer', deviceId: 'mac-2', thisDevice: false, label: 'Mac', online: false, known: true, hostKind: 'desktop' }],
    ['on a server', { kind: 'computer', deviceId: 'srv', thisDevice: false, label: 'srv', online: true, known: true, hostKind: 'server' }],
    ['in the cloud', { kind: 'cloud', deviceId: 'cloud-1' }],
    ['somewhere not read yet', null],
  ] as const)('goes to the App with the assistant living %s', (_where, home) => {
    expect(decide({ shell: shell({ home: home as AssistantShellSnapshot['home'] }) })).toEqual(APP)
    installAssistantShellBridge(); installAppConversationSurfaceBridge(); installAssistantAppEntryBridge()
    installApp()
    publishAssistantShell(shell({ home: home as AssistantShellSnapshot['home'] }))
    publishAssistantAppWord(word)
    publishAppConversationSurfaces(bound)
    try { expect(readAssistantEntryTarget()).toEqual(APP) } finally {
      publishAssistantAppWord(null)
      publishAppConversationSurfaces({})
      noApps()
    }
  })

  it.each([
    ['its conversation is not bound / drawable yet (the first bind, a grant withdrawn)', { surfaces: {} }],
    ['the person picked another conversation for it', { surfaces: { [ASSISTANT_APP_ID]: OTHER } }],
    ['there is no assistant (closed, or never set up): its own no-assistant pages', { shell: shell({ assistant: null, assistantState: 'none', chatId: null }) }],
    ['the assistant is still being read', { shell: shell({ assistantState: 'loading', chatId: null }) }],
  ])('goes to the App\'s own page, nothing drawn beside it, when %s', (_name, over) => {
    expect(decide(over)).toEqual({ ...APP, chatId: null })
  })

  // The App not usable here: the assistant's chat as any chat; no assistant: Settings' 「咕咕」 (setup).
  it.each([
    ['main does not trust it (a spoofed id, a fork, another market source)', { word: { ...word, trusted: false } }],
    ['main\'s word is about another account', { word: { ...word, ownerId: OTHER } }],
    ['main has not answered yet (the App still going in)', { word: null }],
    ['the person switched it off', { appEnabled: false }],
  ])('opens the assistant\'s chat as any chat when %s', (_name, over) => {
    expect(decide(over)).toEqual({ kind: 'chat', chatId: DM })
    expect(decide({ ...over, shell: shell({ assistant: null, assistantState: 'none', chatId: null }) })).toEqual({ kind: 'setup' })
    expect(decide({ ...over, shell: shell({ assistantState: 'loading', chatId: null }) })).toEqual({ kind: 'wait' })
  })

  it('waits while it does not know whose window this is', () => {
    expect(decide({ shell: null })).toEqual({ kind: 'wait' })
    expect(decide({ shell: shell({ ownerId: null }) })).toEqual({ kind: 'wait' })
    // The window's assistant is another account's than main's word.
    expect(decide({ shell: shell({ ownerId: OTHER }) })).toEqual({ kind: 'chat', chatId: DM })
  })
})

describe('openAssistantEntry', () => {
  const opened: unknown[] = []
  const settings: unknown[] = []
  const onLink = (event: Event) => { event.preventDefault(); opened.push((event as CustomEvent<{ target: unknown }>).detail.target) }
  const onSettings = (event: Event) => settings.push((event as CustomEvent).detail)
  beforeEach(() => {
    installAssistantShellBridge(); installAppConversationSurfaceBridge(); installAssistantAppEntryBridge()
    installApp()
    publishAssistantShell(shell())
    publishAssistantAppWord(word)
    publishAppConversationSurfaces(bound)
    appState.navigation.navigate('home')
    opened.length = 0; settings.length = 0
    window.addEventListener('gugu:open-link-target', onLink)
    window.addEventListener('__open_settings', onSettings)
  })
  afterEach(() => {
    window.removeEventListener('gugu:open-link-target', onLink)
    window.removeEventListener('__open_settings', onSettings)
    publishAssistantAppWord(null)
    publishAppConversationSurfaces({})
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, ownerId: null }))
    noApps()
    vi.restoreAllMocks()
  })

  it('opens the App\'s own page (its conversation beside it) and answers that conversation\'s cell', () => {
    expect(readAssistantEntryTarget()).toEqual(APP)
    expect(openAssistantEntry()).toBe(appConversationSlotKey(ASSISTANT_APP_ID))
    expect(appState.navigation.currentViewId).toBe('app')
    expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
    // Already there: left as it is.
    const navigate = vi.spyOn(appState.navigation, 'navigate')
    openAssistantEntry()
    expect(navigate).not.toHaveBeenCalled()
    expect(opened).toEqual([])
  })

  it('opens the App\'s page with nothing to answer while its conversation is not beside it', () => {
    publishAppConversationSurfaces({})
    expect(openAssistantEntry()).toBeNull()
    expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
  })

  it('the App not usable here: opens the assistant\'s chat as any chat; a link caller does it itself', () => {
    installApp(undefined, [ASSISTANT_APP_ID])
    expect(openAssistantEntry()).toBeNull()
    expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
    expect(appState.navigation.currentViewId).toBe('home')
    opened.length = 0
    expect(openAssistantEntry('open', false)).toBeNull()
    expect(opened).toEqual([])
  })

  // 11-12 gap: no assistant and no App, a 开通 (an entry, a reminder) went nowhere once Settings lost its 咕咕 group. Setting it
  // up is the App's: the Apps page on the assistant App — its market page to install it, its own page to switch it on.
  it.each([
    ['not installed', () => noApps()],
    ['switched off', () => installApp(undefined, [ASSISTANT_APP_ID])],
    ['a copy main does not trust', () => publishAssistantAppWord({ ...word, trusted: false })],
  ])('no assistant, the App %s: 开通 opens the Apps page on the assistant App, never Settings', (_why, arrange) => {
    arrange()
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null }))
    expect(readAssistantEntryTarget()).toEqual({ kind: 'setup' })
    expect(openAssistantEntry()).toBeNull()
    expect(opened).toEqual([{ kind: 'app-detail', extensionId: ASSISTANT_APP_ID }])
    expect(settings).toEqual([])
    // A link caller does it itself; the web build has no Apps page.
    opened.length = 0
    openAssistantEntry('open', false)
    host.sessionHost = false
    try { openAssistantEntry() } finally { host.sessionHost = true }
    expect(opened).toEqual([])
  })

  it('opens a task the shell found in the App: its own page, the task over its panel, for this account only', () => {
    const request = { workId: 'w1', title: 'T', assistantId: 'assistant', taskAgentId: 'agent-1', task: { deviceId: 'd', sessionId: 's1' }, assistants: [] }
    installAppHostLayerBridge()
    setAppHostLayerAccount(OWNER)
    try {
      // An App that does not read the assistant's work has no place for it: said, nothing opened.
      expect(() => openAssistantTaskInApp(OWNER, request)).toThrow()
      expect(readAppHostLayerBridge()?.getSnapshot()).toEqual({})
      installApp(['unread', 'surface', 'work'])
      expect(openAssistantTaskInApp(OWNER, request)).toBe(appHostLayerSlotKey(ASSISTANT_APP_ID))
      expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
      expect(readAppHostLayerBridge()?.getSnapshot()[ASSISTANT_APP_ID]).toEqual({ kind: 'work', ownerId: OWNER, request })
      // The task link itself lands in that cell.
      expect(openAssistantEntry('task-chat', false)).toBe(appHostLayerSlotKey(ASSISTANT_APP_ID))
      setAppHostLayerAccount(OTHER)
      expect(() => openAssistantTaskInApp(OWNER, request)).toThrow()
      // The App not usable here: nothing to open it in.
      setAppHostLayerAccount(OWNER)
      publishAssistantAppWord(null)
      expect(openAssistantTaskInApp(OWNER, request)).toBeNull()
    } finally {
      resetAppHostLayersForTest()
      setAppHostLayerAccount(null)
    }
  })

  it('follows each change of the answers', () => {
    expect(readAssistantEntryTarget().kind).toBe('app')
    publishAssistantShell(shell({ ownerId: OTHER }))
    expect(readAssistantEntryTarget().kind).toBe('chat')
    publishAssistantAppWord({ ...word, ownerId: OTHER })
    expect(readAssistantEntryTarget().kind).toBe('app')
  })
})

/**
 * Owner 11-12「设置里面不应该有咕咕设置吧?」: every route of the shell's that used to open Settings' 咕咕 group (资料, 连接应用:
 * notifications, connection prompts, old section links — MainLayout sends them all here) lands in the App: its page, with that
 * page of the assistant over its panel; never a Settings event.
 */
describe('openAssistantPageInApp', () => {
  const opened: unknown[] = []
  const settings: unknown[] = []
  const revealed: unknown[] = []
  const onLink = (event: Event) => { event.preventDefault(); opened.push((event as CustomEvent<{ target: unknown }>).detail.target) }
  const onSettings = (event: Event) => settings.push((event as CustomEvent).detail)
  const onReveal = () => revealed.push(true)
  const layer = () => readAppHostLayerBridge()?.getSnapshot()[ASSISTANT_APP_ID] ?? null
  beforeEach(() => {
    installAssistantShellBridge(); installAppConversationSurfaceBridge(); installAssistantAppEntryBridge(); installAppHostLayerBridge()
    setAppHostLayerAccount(OWNER)
    installApp()
    publishAssistantShell(shell())
    publishAssistantAppWord(word)
    publishAppConversationSurfaces(bound)
    appState.navigation.navigate('home')
    opened.length = 0; settings.length = 0; revealed.length = 0
    window.addEventListener('gugu:open-link-target', onLink)
    window.addEventListener('__open_settings', onSettings)
    window.addEventListener('__sessionpage_reveal', onReveal)
  })
  afterEach(() => {
    window.removeEventListener('gugu:open-link-target', onLink)
    window.removeEventListener('__open_settings', onSettings)
    window.removeEventListener('__sessionpage_reveal', onReveal)
    expect(settings).toEqual([])
    resetAppHostLayersForTest()
    publishAssistantAppWord(null)
    publishAppConversationSurfaces({})
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, ownerId: null }))
    noApps()
  })

  it('资料 with the assistant there: the App\'s page, its settings page over the panel, the panel unfolded', () => {
    setAppConversationPanelCollapsed(ASSISTANT_APP_ID, true)
    expect(openAssistantPageInApp('settings')).toBe(true)
    expect(revealed).toEqual([true])
    expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
    expect(layer()).toEqual({ kind: 'assistant-settings', ownerId: OWNER })
    expect(appConversationPanelCollapsed(ASSISTANT_APP_ID)).toBe(false)
  })

  // Its dialog is its figure alone (owner 11-12): 换模型 / the App's open "model" land on the settings page's model screen.
  it('资料 at its model: the settings page over the panel, asked to open at the model', () => {
    requestAssistantSettingsSection(null)
    expect(openAssistantPageInApp('settings', 'aimodel')).toBe(true)
    expect(layer()).toEqual({ kind: 'assistant-settings', ownerId: OWNER })
    expect(takeAssistantSettingsSection()).toBe('aimodel')
  })

  it('at its model with no settings page to draw (no assistant yet, App not usable): nothing is left asked for', () => {
    requestAssistantSettingsSection(null)
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, setup: 'shell' }))
    expect(openAssistantPageInApp('settings', 'aimodel')).toBe(true)
    expect(layer()).toEqual({ kind: 'assistant-setup', ownerId: OWNER })
    expect(takeAssistantSettingsSection()).toBeNull()
    publishAssistantShell(shell())
    installApp(undefined, [ASSISTANT_APP_ID])
    expect(openAssistantPageInApp('settings', 'aimodel')).toBe(true)
    expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
    expect(takeAssistantSettingsSection()).toBeNull()
  })

  it('连接应用 with the assistant there: its connected apps over the panel', () => {
    expect(openAssistantPageInApp('connected-apps')).toBe(true)
    expect(layer()).toEqual({ kind: 'assistant-connected-apps', ownerId: OWNER })
  })

  it('no assistant yet: 资料 is setting it up; 连接应用 waits on the App\'s page', () => {
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, setup: 'shell' }))
    expect(openAssistantPageInApp('connected-apps')).toBe(true)
    expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
    expect(layer()).toBeNull()
    expect(openAssistantPageInApp('settings')).toBe(true)
    expect(layer()).toEqual({ kind: 'assistant-setup', ownerId: OWNER })
  })

  it('still finding it: the App\'s page alone (it says so), nothing over it', () => {
    publishAssistantShell(shell({ assistant: null, assistantState: 'loading', chatId: null }))
    expect(openAssistantPageInApp('settings')).toBe(true)
    expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
    expect(layer()).toBeNull()
  })

  it('the App not usable (D9/D10): the assistant\'s chat as any chat', () => {
    installApp(undefined, [ASSISTANT_APP_ID])
    expect(openAssistantPageInApp('settings')).toBe(true)
    expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
    expect(appState.navigation.currentViewId).toBe('home')
  })

  // 11-12 gap: no assistant and no App, no Settings group to fall back on. 资料 is 开通: the Apps page on the assistant App, to
  // install or switch it on. The connected apps are the person's own: their computer home, the Library's 集成.
  it('no assistant and the App not usable: 资料 opens the Apps page on the App; 连接应用 the Library\'s 集成; the web build neither', () => {
    installApp(undefined, [ASSISTANT_APP_ID])
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null }))
    expect(openAssistantPageInApp('settings')).toBe(true)
    expect(opened).toEqual([{ kind: 'app-detail', extensionId: ASSISTANT_APP_ID }])
    expect(revealed).toEqual([true])
    opened.length = 0
    expect(openAssistantPageInApp('connected-apps')).toBe(true)
    expect(appState.navigation.currentViewId).toBe('library')
    expect(appState.navigation.viewParamsStore.library?.tab).toBe('integrations')
    expect(opened).toEqual([])
    expect(layer()).toBeNull()
    appState.navigation.navigate('home')
    host.sessionHost = false
    try {
      expect(openAssistantPageInApp('settings')).toBe(false)
      expect(openAssistantPageInApp('connected-apps')).toBe(false)
    } finally { host.sessionHost = true }
    expect(opened).toEqual([])
    expect(appState.navigation.currentViewId).toBe('home')
  })
})

describe('assistantEntryUnread', () => {
  it('is the chat\'s own unread; unknown is not a zero', () => {
    expect(assistantEntryUnread([{ id: DM, unread_count: 2 }], DM)).toBe(true)
    expect(assistantEntryUnread([{ id: DM, unread_count: 0 }], DM)).toBe(false)
    expect(assistantEntryUnread([{ id: OTHER, unread_count: 3 }], DM)).toBeNull()
    expect(assistantEntryUnread([{ id: DM, unread_count: Number.NaN }], DM)).toBeNull()
    expect(assistantEntryUnread([{ id: DM, unread_count: -1 }], DM)).toBeNull()
  })
})
