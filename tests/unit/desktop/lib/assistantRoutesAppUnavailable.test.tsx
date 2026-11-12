// @vitest-environment jsdom
// Entry switch, the rule for every route into the assistant: when the App is not usable here — switched off by the person, still
// being put in, failing to go in — the route falls back to the assistant's chat as an ordinary chat, whichever route it is
// (verify-pass1 D10: a notification row landed on the blank new-task page). Each route below is asked in each of those states,
// through the real decision (lib/assistantEntry.ts) and the real inputs it reads; no route has an answer of its own.
//
// Where a route's own test lives with its component (notification rows: NotificationList.test.tsx; chat, file, draft and notification
// links: MainLayout.test.ts; task links: conversationNavigation7520, assistantWorkLinkOpen, AssistantTaskChats; the restored App
// page: apps-views.test.tsx and assistant-page-fallback.test.tsx), the same three states are used there.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ASSISTANT_APP_ID, openAssistantEntry } from '../../../../apps/desktop/src/lib/assistantEntry'
import { installedExtensionsStore } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store'
import { useAssistantPageNotHere } from '../../../../apps/desktop/src/session/renderer/features/apps/assistant-page-not-here'
import { installAssistantShellBridge, publishAssistantShell, type AssistantShellSnapshot } from '../../../../apps/desktop/src/lib/assistantShellBridge'
import { QUICK_CHAT_CHANNELS } from '../../../../apps/desktop/src/lib/quickChatIpc'
import { QuickChatHost } from '../../../../apps/desktop/src/components/assistant/QuickChatHost'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { NavigationStore } from '../../../../apps/desktop/src/session/renderer/lib/stores/navigation-store'
import { sessionViewCanActivate } from '../../../../apps/desktop/src/session/renderer/features/sessions/session-view-guard'
import { UNAVAILABLE_APP_STATES, clearAssistantAppState, setAssistantAppState } from '../../../support/assistantAppStates'
import { clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import '../../../../apps/desktop/src/i18n/registerAssistantCatalog'

const OWNER = '11000000-0000-4000-8000-000000000001'
const DM = '33000000-0000-4000-8000-000000000003'
const ASSISTANT = 'assistant-agent'

const session = vi.hoisted(() => ({ agentId: 'assistant-agent' }))
vi.mock('@renderer/lib/modal/modal-store', () => ({ modalStore: { closeModal: vi.fn() } }))
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { history: { push: vi.fn() }, sidebar: { revealActiveSession: vi.fn() }, navigation: { currentViewId: 'home', viewParamsStore: {}, navigate: vi.fn() } } }))
vi.mock('@renderer/features/sessions/stores/session-agent-bindings', () => ({ sessionAgentBindings: { bindingFor: () => ({ agentUserId: session.agentId }) } }))
vi.mock('@renderer/features/projects/project-presence', () => ({ projectPresence: () => 'present' }))
vi.mock('@renderer/features/sessions/stores/session-selectors', () => ({ getSessionManagerStore: () => ({ listState: 'read', sessions: new Map([['task', { data: { archivedAt: null } }]]) }) }))
vi.mock('@renderer/features/sessions/leave-session-view', () => ({ sessionLeaveDestination: () => ({ viewId: 'new-session' }) }))

const shell = (over: Partial<AssistantShellSnapshot> = {}): AssistantShellSnapshot => ({
  cloudAvailable: false, canHostHere: true, cloud: null, loadError: null,
  assistant: { id: ASSISTANT, display_name: '咕咕', avatar: null, created_at: null },
  assistantState: 'found', ownerName: 'U', ownerId: OWNER, chatId: DM, home: null, setup: null, member: false, preparing: false, ...over,
})

/** What the window was asked to open, as a link: the chat shell's single door (lib/guguLinks.ts). */
const opened: unknown[] = []
const settings: unknown[] = []
const onLink = (event: Event) => { event.preventDefault(); opened.push((event as CustomEvent<{ target: unknown }>).detail.target) }
const onSettings = (event: Event) => settings.push((event as CustomEvent).detail)
beforeEach(() => {
  installAssistantShellBridge()
  publishAssistantShell(shell())
  session.agentId = ASSISTANT
  opened.length = 0; settings.length = 0
  window.addEventListener('gugu:open-link-target', onLink)
  window.addEventListener(UI_EVENTS.openSettings, onSettings)
})
afterEach(() => {
  window.removeEventListener('gugu:open-link-target', onLink)
  window.removeEventListener(UI_EVENTS.openSettings, onSettings)
  publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null, ownerId: null }))
  clearAssistantAppState()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe.each(UNAVAILABLE_APP_STATES)('the assistant App %s', (state) => {
  beforeEach(() => setAssistantAppState(state, OWNER))

  it('the rail\'s top cell (and the settings links, the meeting reminder, the first-run hand-off, which ask the same) opens its chat as any chat', () => {
    expect(openAssistantEntry()).toBeNull()
    expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
    expect(settings).toEqual([])
  })

  // Owner 11-12: nothing of the assistant is in Settings, so there is no setup page to fall back on there (D9/D10: plain chat).
  // Setting it up is the App's: with no assistant yet, the entry opens the Apps page on the assistant App (to install or switch
  // it on), never a chat or Settings.
  it('with no assistant yet, the same entry opens the Apps page on the assistant App: neither a chat nor a Settings page', () => {
    publishAssistantShell(shell({ assistant: null, assistantState: 'none', chatId: null }))
    openAssistantEntry()
    expect(opened).toEqual([{ kind: 'app-detail', extensionId: 'gugu-assistant' }])
    expect(settings).toEqual([])
  })

  it('restoring the window to the assistant\'s own session view: its chat opens as any chat; the person is not left on a blank page', async () => {
    const store = new NavigationStore()
    store.registerView('session')
    store.registerView('home')
    store.registerView('app')
    store.registerGuard('session', sessionViewCanActivate)
    store.restoreSnapshot({ currentViewId: 'session', viewParams: { session: { projectId: 'project', sessionId: 'task' } } })
    expect(store.currentViewId).toBe('home')
    // Opened once the navigation settled, not from inside the guard.
    expect(opened).toEqual([])
    await Promise.resolve()
    expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
  })

  it('navigating to the assistant\'s own session (a notification, a link, an old layout) opens its chat as any chat, exactly once', async () => {
    const store = new NavigationStore()
    store.registerView('session')
    store.registerView('home')
    store.registerGuard('session', sessionViewCanActivate)
    store.navigate('session', { projectId: 'project', sessionId: 'task' })
    expect(store.currentViewId).toBe('home')
    await Promise.resolve()
    expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
    // Nothing is opened for a task that is not the assistant's.
    opened.length = 0
    session.agentId = 'ordinary-agent'
    store.navigate('session', { projectId: 'project', sessionId: 'task' })
    await Promise.resolve()
    expect(store.currentViewId).toBe('session')
    expect(opened).toEqual([])
  })

  it('opens nothing for the assistant\'s session while it is not known which chat is its chat: nothing is guessed', async () => {
    publishAssistantShell(shell({ assistantState: 'loading', chatId: null }))
    const store = new NavigationStore()
    store.registerView('session')
    store.registerView('home')
    store.registerGuard('session', sessionViewCanActivate)
    // The decision waits (the assistant is still being read): no chat to open, and none is made up.
    store.navigate('session', { projectId: 'project', sessionId: 'task' })
    await Promise.resolve()
    expect(opened).toEqual([])
  })
})

// Restoring the window to the assistant App's own page (verify-pass1 D9): the page is one more route into the assistant.
describe.each(UNAVAILABLE_APP_STATES)('the window restored to the assistant App\'s page, the App %s', (state) => {
  function RestoredPage({ report }: { report: (notHere: boolean) => void }) {
    report(useAssistantPageNotHere(ASSISTANT_APP_ID, !!installedExtensionsStore.mainTabOf(ASSISTANT_APP_ID)?.enabled))
    return null
  }
  it('says it is getting ready, never "switched off", and opens the assistant\'s chat as any chat', async () => {
    const harness = createReactHarness()
    setAssistantAppState(state, OWNER)
    const seen: boolean[] = []
    try {
      await harness.render(<RestoredPage report={(notHere) => seen.push(notHere)} />)
      expect(seen.at(-1)).toBe(true)
      expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
    } finally { harness.cleanup() }
  })
  it('is left alone while the App is usable: nothing is sent away', async () => {
    const harness = createReactHarness()
    setAssistantAppState('usable', OWNER)
    const seen: boolean[] = []
    try {
      await harness.render(<RestoredPage report={(notHere) => seen.push(notHere)} />)
      expect(seen.at(-1)).toBe(false)
      expect(opened).toEqual([])
    } finally { harness.cleanup() }
  })
})

describe.each(UNAVAILABLE_APP_STATES)('quick chat\'s "open in the main window", the assistant App %s', (state) => {
  let harness: ReturnType<typeof createReactHarness>
  let frame: HTMLIFrameElement
  // QuickChatHost keeps the window it opened while that window is open (D7: never re-opened, never navigated again). Each case
  // has its own window: the last one is really closed here (its `close` is stubbed), so the next case is handed its own.
  afterEach(() => {
    harness.cleanup()
    const child = frame.contentWindow
    if (child) Object.defineProperty(child, 'closed', { configurable: true, get: () => true })
    frame.remove()
  })
  it('reveals the main window and opens the assistant\'s chat as any chat', async () => {
    setAssistantAppState(state, OWNER)
    harness = createReactHarness()
    frame = document.createElement('iframe')
    document.body.append(frame)
    const child = frame.contentWindow!
    vi.spyOn(child, 'close').mockImplementation(() => {})
    const invoke = vi.fn(async (channel: string) => channel === QUICK_CHAT_CHANNELS.state ? { supported: true, enabled: true, registered: true, accelerator: 'Alt+Shift+Space' } : undefined)
    vi.stubGlobal('electronAPI', { invoke, eventOn: () => () => undefined })
    vi.spyOn(window, 'open').mockImplementation(() => child)
    const revealed = vi.fn()
    window.addEventListener(UI_EVENTS.sessionpageReveal, revealed)
    try {
      await renderWithAppProviders(harness, createNode(QuickChatHost, {
        assistant: { id: ASSISTANT, display_name: '咕咕', avatar: null, created_at: null }, assistantState: 'found', chatId: DM, chatFailed: null, retryChat: () => {},
      }))
      await clickElement(child.document.querySelector<HTMLButtonElement>('[data-testid="quick-chat-open-main"]')!)
      await act(async () => undefined)
      expect(revealed).toHaveBeenCalledOnce()
      expect(opened).toEqual([{ kind: 'chat', chatId: DM }])
      expect(invoke).toHaveBeenCalledWith(QUICK_CHAT_CHANNELS.openMain)
    } finally { window.removeEventListener(UI_EVENTS.sessionpageReveal, revealed) }
  })
})
