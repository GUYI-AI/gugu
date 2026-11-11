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
  openAssistantTaskInApp,
  publishAssistantAppWord,
  readAssistantEntryTarget,
} from '../../../../apps/desktop/src/lib/assistantEntry'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { appConversationSlotKey, installAppConversationSurfaceBridge, publishAppConversationSurfaces } from '../../../../apps/desktop/src/lib/appConversationSurfaceBridge'
import { appState } from '../../../../apps/desktop/src/session/renderer/lib/stores/app-state'
import { appHostLayerSlotKey, installAppHostLayerBridge, readAppHostLayerBridge, resetAppHostLayersForTest, setAppHostLayerAccount } from '../../../../apps/desktop/src/lib/appHostLayerBridge'
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { EXTENSION_API_VERSION } from '../../../../apps/desktop/src/session/shared/extensions/manifest'

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

  it('the App not usable here: opens the assistant\'s chat as any chat, or setup when there is no assistant; a link caller does it itself', () => {
    installApp(undefined, [ASSISTANT_APP_ID])
    expect(openAssistantEntry()).toBeNull()
    expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
    expect(appState.navigation.currentViewId).toBe('home')
    opened.length = 0
    expect(openAssistantEntry('open', false)).toBeNull()
    expect(opened).toEqual([])
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null }))
    openAssistantEntry()
    expect(settings).toEqual([{ section: 'assistant' }])
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

describe('assistantEntryUnread', () => {
  it('is the chat\'s own unread; unknown is not a zero', () => {
    expect(assistantEntryUnread([{ id: DM, unread_count: 2 }], DM)).toBe(true)
    expect(assistantEntryUnread([{ id: DM, unread_count: 0 }], DM)).toBe(false)
    expect(assistantEntryUnread([{ id: OTHER, unread_count: 3 }], DM)).toBeNull()
    expect(assistantEntryUnread([{ id: DM, unread_count: Number.NaN }], DM)).toBeNull()
    expect(assistantEntryUnread([{ id: DM, unread_count: -1 }], DM)).toBeNull()
  })
})
