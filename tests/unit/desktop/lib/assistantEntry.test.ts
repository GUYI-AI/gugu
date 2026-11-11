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

describe('decideAssistantEntry', () => {
  it('goes to the App when it is the trusted one for this account and drawn beside the account\'s own assistant chat', () => {
    expect(decideAssistantEntry({ shell: shell(), word, surfaces: bound })).toEqual(APP)
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
    expect(decideAssistantEntry({ shell: shell({ home: home as AssistantShellSnapshot['home'] }), word, surfaces: bound })).toEqual(APP)
    installAssistantShellBridge(); installAppConversationSurfaceBridge(); installAssistantAppEntryBridge()
    publishAssistantShell(shell({ home: home as AssistantShellSnapshot['home'] }))
    publishAssistantAppWord(word)
    publishAppConversationSurfaces(bound)
    expect(readAssistantEntryTarget()).toEqual(APP)
    publishAssistantAppWord(null)
    publishAppConversationSurfaces({})
  })

  it.each([
    ['main does not trust it (a spoofed id, a fork, another market source)', { word: { ...word, trusted: false } }],
    ['main\'s word is about another account', { word: { ...word, ownerId: OTHER } }],
    ['main has not answered yet', { word: null }],
    ['it is not bound / not drawable (the person picked another chat, withdrew a grant, switched it off)', { surfaces: {} }],
    ['it is drawn beside another chat', { surfaces: { [ASSISTANT_APP_ID]: OTHER } }],
    ['another App is drawn beside the assistant chat', { surfaces: { 'other-app': DM } }],
    ['there is no assistant (closed, or never set up)', { shell: shell({ assistant: null, assistantState: 'none', chatId: null }) }],
    ['the assistant is still being read', { shell: shell({ assistantState: 'loading' }) }],
    ['the window\'s assistant is another account\'s', { shell: shell({ ownerId: OTHER }) }],
    ['the assistant has no chat yet', { shell: shell({ chatId: null }) }],
    ['the assistant is unknown', { shell: null }],
  ])('stays on the built-in page when %s', (_name, over) => {
    expect(decideAssistantEntry({ shell: shell(), word, surfaces: bound, ...over } as Parameters<typeof decideAssistantEntry>[0])).toEqual({ kind: 'built-in' })
  })

  it('opens a task\'s conversation in the App only when the App reads the assistant\'s work (API 46)', () => {
    expect(decideAssistantEntry({ shell: shell(), word, surfaces: bound, purpose: 'task-chat', appReadsWork: true })).toEqual(APP)
    expect(decideAssistantEntry({ shell: shell(), word, surfaces: bound, purpose: 'task-chat', appReadsWork: false })).toEqual({ kind: 'built-in' })
  })

  it('keeps recording a meeting host-owned (the built-in recorder)', () => {
    expect(decideAssistantEntry({ shell: shell(), word, surfaces: bound, purpose: 'record-meeting', appReadsWork: true })).toEqual({ kind: 'built-in' })
  })
})

describe('openAssistantEntry', () => {
  beforeEach(() => {
    installAssistantShellBridge(); installAppConversationSurfaceBridge(); installAssistantAppEntryBridge()
    publishAssistantShell(shell())
    publishAssistantAppWord(word)
    publishAppConversationSurfaces(bound)
    appState.navigation.navigate('home')
  })
  afterEach(() => {
    publishAssistantAppWord(null)
    publishAppConversationSurfaces({})
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, ownerId: null }))
    vi.restoreAllMocks()
  })

  it('opens the App\'s own page (its conversation beside it) and answers that conversation\'s cell; the built-in page is not touched', () => {
    const builtIn = vi.fn(() => 'assistant:chat')
    expect(readAssistantEntryTarget()).toEqual(APP)
    expect(openAssistantEntry(builtIn)).toBe(appConversationSlotKey(ASSISTANT_APP_ID))
    expect(builtIn).not.toHaveBeenCalled()
    expect(appState.navigation.currentViewId).toBe('app')
    expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
    // Already there: left as it is.
    const navigate = vi.spyOn(appState.navigation, 'navigate')
    openAssistantEntry(builtIn)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('runs the entry\'s own built-in way, unchanged, whenever the decision is the built-in page', () => {
    publishAssistantAppWord({ ...word, trusted: false })
    const builtIn = vi.fn(() => 'assistant:chat')
    expect(openAssistantEntry(builtIn)).toBe('assistant:chat')
    expect(builtIn).toHaveBeenCalledOnce()
    expect(appState.navigation.currentViewId).toBe('home')
    publishAssistantAppWord(word)
    expect(openAssistantEntry(builtIn, 'task-chat')).toBe('assistant:chat')
    expect(builtIn).toHaveBeenCalledTimes(2)
  })

  it('opens a task the shell found in the App: its own page, the task over its panel, for this account only', () => {
    const request = { workId: 'w1', title: 'T', assistantId: 'assistant', taskAgentId: 'agent-1', task: { deviceId: 'd', sessionId: 's1' }, assistants: [] }
    const manifest = (actions: string[]) => ({ id: ASSISTANT_APP_ID, name: 'A', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
      permissions: { capabilities: ['chat:unread'], bindings: [{ name: 'main', kind: 'conversation', actions }] }, contributes: { tabs: [{ name: 'today', title: 'A' }] } })
    const apply = (actions: string[]) => installedExtensionsStore.applyList({ extensions: [manifest(actions)], invalid: [], icons: {}, disabled: [], disclosure: {}, dock: [] } as never)
    installAppHostLayerBridge()
    setAppHostLayerAccount(OWNER)
    try {
      apply(['unread', 'surface'])
      expect(openAssistantTaskInApp(OWNER, request)).toBeNull()
      expect(readAppHostLayerBridge()?.getSnapshot()).toEqual({})
      apply(['unread', 'surface', 'work'])
      expect(openAssistantTaskInApp(OWNER, request)).toBe(appHostLayerSlotKey(ASSISTANT_APP_ID))
      expect(appState.navigation.viewParamsStore.app?.appId).toBe(ASSISTANT_APP_ID)
      expect(readAppHostLayerBridge()?.getSnapshot()[ASSISTANT_APP_ID]).toEqual({ kind: 'work', ownerId: OWNER, request })
      // The task link itself lands in that cell.
      expect(openAssistantEntry(() => 'assistant:task-chat', 'task-chat')).toBe(appHostLayerSlotKey(ASSISTANT_APP_ID))
      setAppHostLayerAccount(OTHER)
      expect(() => openAssistantTaskInApp(OWNER, request)).toThrow()
    } finally {
      resetAppHostLayersForTest()
      setAppHostLayerAccount(null)
      installedExtensionsStore.applyList({ extensions: [], invalid: [], icons: {}, disabled: [], disclosure: {}, dock: [] } as never)
    }
  })

  it('follows each change of the three answers', () => {
    expect(readAssistantEntryTarget().kind).toBe('app')
    publishAppConversationSurfaces({})
    expect(readAssistantEntryTarget().kind).toBe('built-in')
    publishAppConversationSurfaces(bound)
    publishAssistantShell(shell({ ownerId: OTHER }))
    expect(readAssistantEntryTarget().kind).toBe('built-in')
    publishAssistantAppWord({ ...word, ownerId: OTHER })
    publishAssistantShell(shell({ ownerId: OTHER }))
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
