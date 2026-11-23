// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { ChatTabPage } from '../../../../apps/desktop/src/components/appSlot/ChatTabHosts'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { useMessageFilePreview } from '../../../../apps/desktop/src/components/chat/useMessageFilePreview'
import { appsHere } from '../../../../apps/desktop/src/components/appSlot/appsHere'
import { OpenSuperseded, openLinkTarget } from '../../../../apps/desktop/src/lib/guguLinks'
import { askChatFile, chatLayoutOf, closeChatTab, focusedChatTab, panelTabsOf, shownPanelTab, takeChatAsk } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { isWaitingItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import { translateSessionMessage } from '../../../../apps/desktop/src/session/renderer/localization/locale-store'
import type { AppOpenWithDetail } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

/**
 * A file clicked (a card, a link in a message) shows its tab in the same task: titled, its page waiting, before the host
 * is asked; the host's answer turns that same tab into the real page. An open that does not come to a page takes its
 * tab with it. Driven through the real link layer and the chat's opener; only the host and the network are stand-ins.
 */
const state = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: async () => null }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc: async () => ({ error: null }) } }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', async (original) => ({ ...await original<object>(), useMobileShell: () => state.mobile, readMobileShell: () => state.mobile }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: vi.fn() } }))

let serial = 0
let group = '', other = ''
const toast = vi.fn()
let harness: ReturnType<typeof createReactHarness>
const host = () => vi.mocked(appsHere!.groupFileOpener)
/** The host's answers held until the test lets each go (`fail`: its refusal). */
const held = new Map<string, (fail?: string) => void>()
/** What the host answers for a file (default: its preview here). */
const answers = new Map<string, AppOpenWithDetail>()
const setAnswer = (itemId: string, detail: AppOpenWithDetail) => answers.set(itemId, detail)
const preview = (itemId: string, chatId = group): AppOpenWithDetail => ({ chatId, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`, file: { document: false, contentType: 'text/markdown', version: 1, size: 3 }, choice: { kind: 'none' } } as AppOpenWithDetail)
const claimed = (itemId: string): AppOpenWithDetail => ({ ...preview(itemId), choice: { kind: 'one', candidate: { tabKind: 'workspace.file', suffix: '.md' } } } as AppOpenWithDetail)

/** The chat's panel: drawn or not (`panel`), taking asks or not just now (`canTake`). */
function Panel({ canTake }: { canTake?: () => boolean }) {
  return createElement('div', null, useChatOpener(group, undefined, canTake).overlay, state.mobile ? createElement(ChatTabPage, { chatId: group, panel: () => null, info: () => null }) : null)
}
function Shell({ panel = true, canTake }: { panel?: boolean; canTake?: () => boolean }) {
  useLinkNavigation({ ownerId: 'owner', chats: () => [{ id: group, kind: 'group' }, { id: other, kind: 'group' }] as never, contacts: () => [],
    openChat() {}, openApp() {}, openOwnApp() {}, openProject() {}, openAssistant() {},
    // As the chat shell hands an answered file to its chat (MainLayout `openFile`).
    openFile: (chatId, target, source, opener) => askChatFile(chatId, { itemId: target.itemId, opener, ...(source.message ? { message: source.message } : {}), ...(source.restore ? { restore: source.restore } : {}) }),
  })
  const files = useMessageFilePreview({ mobile: false, visible: true, closeRightSurfaces() {}, toast })
  const card = (itemId: string) => createElement('button', { 'data-card': itemId, onClick: () => files.open({ kind: 'file', fileName: `${itemId}.md`, mimeType: 'text/markdown', sizeBytes: 3, source: { kind: 'item', itemId, version: 1 } }, { id: `m-${itemId}`, chat_id: group } as MessageItem) })
  return createElement('div', null, panel ? createElement(Panel, { canTake }) : null, card('A'), card('B'), card('C'))
}
/** A card clicked; what is true right after the click handler returns is read synchronously by the caller. */
const click = (itemId: string) => { act(() => harness.container.querySelector<HTMLButtonElement>(`[data-card="${itemId}"]`)!.click()) }
const settle = () => act(async () => { await new Promise<void>((done) => setTimeout(done, 0)) })
/** The host answers `itemId`: with `how` (set beforehand with setAnswer when not its preview here), or refuses (a string). */
const answer = async (itemId: string, how: AppOpenWithDetail | string) => {
  if (typeof how !== 'string') setAnswer(itemId, how)
  await until(`${itemId} is asked of the host`, () => held.has(itemId))
  await act(async () => { held.get(itemId)!(typeof how === 'string' ? how : undefined); await new Promise<void>((done) => setTimeout(done, 0)) })
}
const tabs = () => panelTabsOf(group)

beforeEach(() => {
  harness = createReactHarness()
  group = `opening-${++serial}`; other = `opening-other-${serial}`
  state.mobile = false
  toast.mockReset(); held.clear(); answers.clear(); host().mockReset()
  host().mockImplementation(({ itemId }) => new Promise((resolve) => held.set(itemId, (fail) => resolve((fail ? { success: false, error: fail } : { success: true, data: answers.get(itemId) ?? preview(itemId) }) as never))))
})
afterEach(() => { for (const tab of tabs()) closeChatTab(group, tab.tabId); harness.cleanup() })

describe('a file card clicked: its tab at once, made real in place', () => {
  it.each([['the host\'s preview', preview], ['an App that claims it', claimed]] as const)('the same tab becomes %s', async (_name, how) => {
    setAnswer('A', how('A'))
    await harness.render(createElement(Shell))
    click('A')
    // In the click's own task: the file's tab, titled with the card's name, waiting.
    expect(tabs()).toHaveLength(1)
    const waiting = tabs()[0]!
    expect(isWaitingItem(waiting.item)).toBe(true)
    expect(waiting.item.title).toBe('A.md')
    expect(shownPanelTab(group)?.tabId).toBe(waiting.tabId)
    await answer('A', how('A'))
    expect(tabs().map((tab) => tab.tabId), 'the same tab, not a second one').toEqual([waiting.tabId])
    expect(isWaitingItem(tabs()[0]!.item)).toBe(false)
    if (how === preview) expect(tabs()[0]!.item).toMatchObject({ kind: null, itemId: 'A', file: { version: 1 } })
    else expect(tabs()[0]!.item).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
    expect(toast).not.toHaveBeenCalled()
  })

  it('a visible file clicked again stays shown without moving current focus or adding a tab; the host is still asked', async () => {
    await harness.render(createElement(Shell))
    click('A'); await answer('A', preview('A'))
    click('B'); await answer('B', preview('B'))
    const a = tabs().find(tab => tab.item.itemId === 'A')!, b = tabs().find(tab => tab.item.itemId === 'B')!
    expect(shownPanelTab(group)?.tabId).toBe(b!.tabId)
    const current = focusedChatTab(group)
    click('A')
    expect(tabs().find(tab => tab.tabId === a.tabId)?.shown).toBe(true)
    expect(focusedChatTab(group)).toEqual(current)
    expect(tabs()).toHaveLength(2)
    expect(tabs().some((tab) => isWaitingItem(tab.item))).toBe(false)
    await answer('A', preview('A'))
    expect(tabs().map((tab) => tab.tabId).sort()).toEqual([a!.tabId, b!.tabId].sort())
    expect(host()).toHaveBeenCalledTimes(3)
  })

  it('the same file clicked again while it opens: still one waiting tab, the host asked once', async () => {
    await harness.render(createElement(Shell))
    click('A')
    click('A')
    expect(tabs()).toHaveLength(1)
    await answer('A', preview('A'))
    expect(tabs()).toHaveLength(1)
    expect(host()).toHaveBeenCalledOnce()
  })
})

describe('an open that does not come to a page takes its tab with it', () => {
  it('the host refuses: the tab goes, the card says so once', async () => {
    await harness.render(createElement(Shell))
    click('A')
    expect(tabs()).toHaveLength(1)
    await answer('A', 'No such file in this chat')
    expect(tabs()).toHaveLength(0)
    await until('the refusal is said', () => toast.mock.calls.length > 0)
    expect(toast).toHaveBeenCalledOnce()
  })

  it('A, then B before A is answered: A\'s tab becomes B\'s in place, A is superseded silently, only B is left', async () => {
    await harness.render(createElement(Shell))
    const a = openLinkTarget({ kind: 'file', itemId: 'A' }, { message: { id: 'm', chat_id: group } as MessageItem, fileName: 'A.md' })
    const outcome = a.then(() => 'opened', (error: unknown) => error instanceof OpenSuperseded ? 'superseded' : `failed: ${String(error)}`)
    await settle()
    const waiting = tabs()[0]!.tabId
    click('B')
    expect(tabs().map((tab) => [tab.tabId, tab.item.itemId])).toEqual([[waiting, 'B']])
    await answer('B', preview('B'))
    await answer('A', preview('A'))
    expect(await outcome).toBe('superseded')
    expect(tabs().map((tab) => [tab.tabId, tab.item.itemId])).toEqual([[waiting, 'B']])
    expect(isWaitingItem(tabs()[0]!.item)).toBe(false)
    expect(toast).not.toHaveBeenCalled()
  })

  it('the file is another chat\'s (a forwarded file message): nothing is left here, that chat is handed the file', async () => {
    setAnswer('A', preview('A', other))
    await harness.render(createElement(Shell))
    click('A')
    expect(tabs()).toHaveLength(1)
    await answer('A', preview('A', other))
    expect(tabs()).toHaveLength(0)
    expect(takeChatAsk(other)).toMatchObject({ itemId: 'A', opener: { chatId: other } })
  })

  it('the shell goes away while the host answers: the waiting tab does not stay', async () => {
    await harness.render(createElement(Shell))
    click('A')
    expect(tabs()).toHaveLength(1)
    await harness.render(null)
    await answer('A', preview('A'))
    expect(tabs()).toHaveLength(0)
  })

  it('a waiting tab is never kept: a restart does not bring back a tab that waits forever', async () => {
    await harness.render(createElement(Shell))
    click('A')
    expect(tabs()).toHaveLength(1)
    const saved = JSON.parse(JSON.stringify(chatLayoutOf(group).snapshot))
    expect(JSON.stringify(saved)).not.toContain('"A"')
    const restored = chatLayoutOf(`${group}-restarted`)
    restored.restoreSnapshot(saved)
    expect(panelTabsOf(`${group}-restarted`).some((tab) => isWaitingItem(tab.item))).toBe(false)
    await answer('A', 'gone')
  })
})

describe('the waiting tab closed by the person before the answer', () => {
  it('a card\'s file (its own tab, beside the chat): the answer still opens the file', async () => {
    await harness.render(createElement(Shell))
    click('A')
    act(() => closeChatTab(group, tabs()[0]!.tabId))
    expect(tabs()).toHaveLength(0)
    await answer('A', preview('A'))
    expect(tabs().map((tab) => tab.item.itemId)).toEqual(['A'])
    expect(isWaitingItem(tabs()[0]!.item)).toBe(false)
  })
})

describe('a file link in a message\'s text', () => {
  it('its message given (the bubble passes it): the waiting tab is there, titled for now, renamed with the answer', async () => {
    await harness.render(createElement(Shell))
    let opened!: Promise<unknown>
    act(() => { opened = openLinkTarget({ kind: 'file', itemId: 'A' }, { message: { id: 'm', chat_id: group } as MessageItem }); void opened.catch(() => undefined) })
    expect(tabs()).toHaveLength(1)
    expect(tabs()[0]!.item.title).toBe(translateSessionMessage('task.loading'))
    await answer('A', preview('A'))
    await opened
    expect(tabs()[0]!.item).toMatchObject({ title: 'A.md', file: { version: 1 } })
  })

  it('no message to say where (a task page\'s text): nothing opens early; the answer opens it as before', async () => {
    await harness.render(createElement(Shell))
    let opened!: Promise<unknown>
    act(() => { opened = openLinkTarget({ kind: 'file', itemId: 'A' }); void opened.catch(() => undefined) })
    expect(tabs()).toHaveLength(0)
    await answer('A', preview('A'))
    await opened
    expect(tabs().map((tab) => tab.item.itemId)).toEqual(['A'])
  })
})

describe('the pair beside the chat', () => {

  it('the waiting tab comes as a file does, half each; turning real does not move the cut', async () => {
    chatLayoutOf(group).setDimensions(1200, 800)
    await harness.render(createElement(Shell))
    click('A')
    expect(chatLayoutOf(group).paneSizes).toEqual([50, 50])
    await answer('A', claimed('A'))
    expect(chatLayoutOf(group).paneSizes).toEqual([50, 50])
  })
})

describe('on the phone', () => {
  it('the waiting page fills the screen and a failure goes back to the chat', async () => {
    state.mobile = true
    await harness.render(createElement(Shell))
    click('A')
    expect(chatLayoutOf(group).narrow).toBe(true)
    expect(focusedChatTab(group)).toMatchObject({ kind: 'panel', tabId: tabs()[0]!.tabId })
    await answer('A', 'No such file in this chat')
    expect(tabs()).toHaveLength(0)
    expect(focusedChatTab(group)?.kind).toBe('chat')
  })

  it('the waiting page becomes the real one in place', async () => {
    state.mobile = true
    await harness.render(createElement(Shell))
    click('A')
    const waiting = tabs()[0]!.tabId
    expect(focusedChatTab(group)).toMatchObject({ kind: 'panel', tabId: waiting })
    await answer('A', preview('A'))
    expect(focusedChatTab(group)).toMatchObject({ kind: 'panel', tabId: waiting })
    expect(isWaitingItem(tabs()[0]!.item)).toBe(false)
  })
})

// The chat not yet taking the waiting ask when the open ends (not drawn yet, or not taking asks just now — an agent's
// task page coming up): what the open left there goes with it, the ask in the chat's mailbox too.
describe('a waiting ask the chat has not taken yet', () => {
  const allow = { now: false }
  const letTake = async () => act(async () => { allow.now = true; window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId: group } })); await new Promise<void>((done) => setTimeout(done, 0)) })

  it.each(['not drawn', 'not taking asks'])('the host refuses while the chat is %s: no tab once it is, nothing left in its mailbox', async (why) => {
    allow.now = false
    await harness.render(why === 'not drawn' ? createElement(Shell, { panel: false }) : createElement(Shell, { canTake: () => allow.now }))
    click('A')
    expect(tabs()).toHaveLength(0)
    await answer('A', 'No such file in this chat')
    if (why === 'not drawn') await harness.render(createElement(Shell))
    else await letTake()
    expect(tabs()).toHaveLength(0)
    expect(takeChatAsk(group)).toBeNull()
  })

  it('another chat\'s file while this chat is not drawn: nothing here, that chat is handed the file', async () => {
    setAnswer('A', preview('A', other))
    await harness.render(createElement(Shell, { panel: false }))
    click('A')
    await answer('A', preview('A', other))
    await harness.render(createElement(Shell))
    expect(tabs()).toHaveLength(0)
    expect(takeChatAsk(group)).toBeNull()
    expect(takeChatAsk(other)).toMatchObject({ itemId: 'A', opener: { chatId: other } })
  })

  it('the chat drawn late but before the answer: the waiting tab is there, then turns real in place', async () => {
    await harness.render(createElement(Shell, { panel: false }))
    click('A')
    expect(tabs()).toHaveLength(0)
    await harness.render(createElement(Shell))
    await until('the waiting tab is taken', () => tabs().length === 1)
    const waiting = tabs()[0]!
    expect(isWaitingItem(waiting.item)).toBe(true)
    await answer('A', preview('A'))
    expect(tabs().map((tab) => tab.tabId)).toEqual([waiting.tabId])
    expect(isWaitingItem(tabs()[0]!.item)).toBe(false)
  })
})
