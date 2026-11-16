// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * A file clicked in an App's page beside a chat (the chat's folder, an App's list): main says so before it resolves the
 * file (`openingChatFile`), and the window shows the file's waiting page as that page's next page in its tab — the shell's
 * waiting tab, the one a file card's click shows. The answer (`openWith`, `announced`) turns that page into the file in
 * place; an open that comes to no page here takes it back, to the folder. Driven through the window's real action
 * handler and the chat's real opener; main's two actions are given as it sends them.
 */
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn(), currentViewId: 'chat' } } }))
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: new Map() }) }))
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({ AcpChatTabResource: class {} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: async () => null }))
/** Each answer that comes to a page is kept as opened (最近打开): how an answer not dropped shows. */
const noted = vi.hoisted(() => vi.fn(async () => ({ error: null })))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc: noted } }))
const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', async (original) => ({ ...await original<object>(), useMobileShell: () => shell.mobile }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: vi.fn(), runs: () => true } }))

const { applyExtensionHostAction } = await import('@renderer/features/extensions/host-action-handlers')
const { askChat, chatLayoutOf, closeChatTab, focusedChatTab, openPanelItem, panelTabsOf, takeChatAsk, chatPaneOf } = await import('@renderer/features/chats/chat-tabs/chat-layouts')
const { folderItem, groupPageSlot, isFolderItem, isUnresolvedItem } = await import('@renderer/features/chats/chat-tabs/chat-panel-item')
const { beginTabFileOpen, failFileOpen } = await import('@renderer/features/chats/chat-tabs/file-opens')
const { useChatOpener } = await import('../../../../apps/desktop/src/components/appSlot/useChatOpener')
const { displayNameOf } = await import('../../../../apps/desktop/src/session/shared/extensions/file-openers')
const { translateSessionMessage } = await import('../../../../apps/desktop/src/session/renderer/localization/locale-store')
const { UI_EVENTS } = await import('../../../../apps/desktop/src/lib/uiEvents')
const { APP_OPEN_WITH_EVENT } = await import('../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol')
type Detail = import('../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol').AppOpenWithDetail

let serial = 0
let chat = '', other = ''
let harness: ReturnType<typeof createReactHarness>
/** The chat's opener; its `openWith` as the phone's frame hands a page's answer to it (GroupTabContent `onOpenWith`). */
const panel = { openWith: null as null | ((detail: Detail, from?: string) => void) }
function Panel({ chatId }: { chatId: string }) { const opener = useChatOpener(chatId); panel.openWith = opener.openWith; return createElement('div', null, opener.overlay) }
/** The chat shell's 「用 X 打开」 (MainLayout `onOpenWith`): the file's chat up, its panel asked with the answer. */
function shellOpenWith(event: Event) {
  const detail = (event as CustomEvent<Detail>).detail
  askChat(detail.chatId, { itemId: detail.itemId, opener: detail, ...(detail.from ? { from: detail.from } : {}) })
  window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId: detail.chatId } }))
}
/** What main sends for the page in the folder tab: through the window's handler, as the bridge's relay delivers it. */
const send = (action: unknown) => act(async () => { await applyExtensionHostAction({ origin: { pageId: null, extensionId: 'workspace', sessionId: null, tabId: groupPageSlot(chat, folder) }, action: action as never }); await new Promise<void>((done) => setTimeout(done, 0)) })
/** Main's opens, by file: each `opening` is a new open (its id), each answer or withdrawal settles the oldest one. */
const pending = new Map<string, string[]>()
let opened = 0
const opening = (itemId: string, extra: Record<string, unknown> = {}) => {
  const openId = `open-${itemId}-${++opened}`
  pending.set(itemId, [...(pending.get(itemId) ?? []), openId])
  return send({ kind: 'openingChatFile', openId, itemId, intent: 'navigate', ...extra })
}
const oldest = (itemId: string) => { const [openId, ...rest] = pending.get(itemId) ?? []; pending.set(itemId, rest); return openId }
const withdraw = (itemId: string) => send({ kind: 'openingChatFile', openId: oldest(itemId), withdrawn: true })
/** The answer for the oldest open of this file (`held: false`: an answer main announced nothing for). */
const answer = (itemId: string, extra: Partial<Detail> = {}, held = true) => send({ kind: 'openWith', detail: {
  chatId: chat, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`, file: { document: false, contentType: 'text/markdown', version: 1, size: 3 },
  choice: { kind: 'one', candidate: { extensionId: 'workspace', tabKind: 'workspace.file', tabTitle: 'Files', app: { name: 'Files' }, onlyTab: false, suffix: '.md' } }, intent: 'navigate',
  ...(held ? { openId: oldest(itemId) } : {}), ...extra,
} })
let folder = ''
const page = () => panelTabsOf(chat).find((tab) => tab.tabId === folder)?.item
const history = () => chatPaneOf(chat, folder)!.navigationOf(folder)!

beforeEach(async () => {
  harness = createReactHarness()
  chat = `app-opening-${++serial}`; other = `app-opening-other-${serial}`
  pending.clear()
  window.addEventListener(APP_OPEN_WITH_EVENT, shellOpenWith)
  folder = openPanelItem(chat, folderItem())!
  await harness.render(createElement(Panel, { chatId: chat }))
})
afterEach(() => {
  window.removeEventListener(APP_OPEN_WITH_EVENT, shellOpenWith)
  for (const tab of panelTabsOf(chat)) closeChatTab(chat, tab.tabId)
  harness.cleanup()
})

describe('a file clicked in the chat\'s folder', () => {
  it('waits as the folder tab\'s next page, then is that file in place: one page more, Back to the folder', async () => {
    await opening('A', { fileName: 'A.md' })
    expect(panelTabsOf(chat)).toHaveLength(1)
    expect(isUnresolvedItem(page())).toBe(true)
    expect(page()?.title).toBe('A.md')
    expect(history().pages).toHaveLength(2)
    await answer('A')
    expect(panelTabsOf(chat).map((tab) => tab.tabId)).toEqual([folder])
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
    expect(history().pages).toHaveLength(2)
    await act(async () => { await chatPaneOf(chat, folder)!.go(folder, -1) })
    expect(isFolderItem(page())).toBe(true)
  })

  it('refused: back to the folder page, the tab where it was, no waiting page left in Back or Forward', async () => {
    await opening('A')
    expect(history().pages).toHaveLength(2)
    await withdraw('A')
    expect(panelTabsOf(chat).map((tab) => tab.tabId)).toEqual([folder])
    expect(isFolderItem(page())).toBe(true)
    expect(history().pages).toHaveLength(1)
    expect(chatPaneOf(chat, folder)!.canGo(folder, 1)).toBe(false)
  })

  it('who opens it is for the person to pick: the waiting page goes, the pick is offered', async () => {
    await opening('A')
    const candidate = (extensionId: string) => ({ extensionId, tabKind: `${extensionId}.file`, tabTitle: extensionId, app: { name: extensionId, defaultLocale: 'en' }, onlyTab: false, suffix: '.md' })
    await answer('A', { choice: { kind: 'choose', suffix: '.md', candidates: [candidate('workspace'), candidate('notes')] } as never })
    expect(isFolderItem(page())).toBe(true)
    expect(history().pages).toHaveLength(1)
    expect(harness.container.textContent, 'the pick is offered over the chat').toContain('notes')
  })

  it('another chat\'s file: nothing waits here, that chat is handed the file', async () => {
    await opening('A')
    // The answer names another chat: the window takes its wait here back and hands that chat the file.
    await answer('A', { chatId: other })
    expect(isFolderItem(page())).toBe(true)
    expect(takeChatAsk(other)).toMatchObject({ itemId: 'A', opener: { chatId: other } })
  })

  it('A, then B while A waits: B in A\'s place; A\'s answer coming back later opens nothing', async () => {
    await opening('A')
    await opening('B')
    expect(page()).toMatchObject({ itemId: 'B' })
    expect(history().pages).toHaveLength(2)
    await answer('B')
    await answer('A')
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'B' })
    expect(panelTabsOf(chat).map((tab) => tab.item.itemId)).toEqual(['B'])
    expect(history().pages).toHaveLength(2)
  })

  it('the waiting page closed by the person: its answer coming back opens nothing', async () => {
    await opening('A')
    act(() => closeChatTab(chat, folder))
    await answer('A')
    expect(panelTabsOf(chat)).toHaveLength(0)
  })

  it('the same file clicked twice in the App: one waiting page, the first answer makes it the file, the second opens nothing', async () => {
    await opening('A')
    await opening('A')
    expect(history().pages).toHaveLength(2)
    await answer('A')
    await answer('A')
    expect(panelTabsOf(chat)).toHaveLength(1)
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
    expect(history().pages).toHaveLength(2)
  })

  it('waits under the name the page gave, then shows the name the host resolved — whatever the page claimed', async () => {
    await opening('A', { fileName: 'claimed-by-the-page.md' })
    expect(page()?.title).toBe('claimed-by-the-page.md')
    await answer('A')
    expect(page()?.title).toBe(displayNameOf('A.md', '.md'))
  })

  it('no name given: the waiting page has the loading wording, then the resolved name', async () => {
    await opening('A')
    expect(page()?.title).toBe(translateSessionMessage('task.loading'))
    await answer('A')
    expect(page()?.title).toBe(displayNameOf('A.md', '.md'))
  })

  it('an answer not held to a wait (nothing was announced) opens as before', async () => {
    await answer('A', {}, false)
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
  })
})

// The independent review of 80a6b15d37: each finding as it shows on screen. An open is known by its id; its waiting page
// by that id; nothing is matched by (chat, file) any more.
describe('review findings: an open is known by its id', () => {
  it('1. opening a file already open here: that tab in front, and the answer still goes to it (its state refreshed)', async () => {
    await answer('A', {}, false)
    const tab = panelTabsOf(chat).find((each) => each.item.itemId === 'A')!.tabId
    await opening('A')
    expect(panelTabsOf(chat).some((each) => isUnresolvedItem(each.item)), 'no waiting page: it is open already').toBe(false)
    noted.mockClear()
    await answer('A')
    await vi.waitFor(() => expect(noted).toHaveBeenCalledWith('workspace_note_open', { p_item_id: 'A' }))
    expect(panelTabsOf(chat).find((each) => each.tabId === tab)?.item).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
  })

  it('3. Back from the waiting page: its answer opens nothing, and Forward does not reach a page that waits forever', async () => {
    await opening('A')
    await act(async () => { await chatPaneOf(chat, folder)!.go(folder, -1) })
    expect(isFolderItem(page())).toBe(true)
    await answer('A')
    expect(isFolderItem(page())).toBe(true)
    expect(chatPaneOf(chat, folder)!.canGo(folder, 1)).toBe(false)
    expect(history().pages).toHaveLength(1)
  })

  it('4. opened in a tab of its own, the asking App tab closed meanwhile: taken back all the same', async () => {
    await opening('A', { intent: 'newTab' })
    const waiting = panelTabsOf(chat).find((each) => isUnresolvedItem(each.item))!.tabId
    expect(waiting).not.toBe(folder)
    act(() => closeChatTab(chat, folder))
    await withdraw('A')
    expect(panelTabsOf(chat).map((each) => each.tabId)).not.toContain(waiting)
    expect(panelTabsOf(chat).some((each) => isUnresolvedItem(each.item))).toBe(false)
  })

  it('5. an earlier open of the same file failing late takes back its own wait only, never a newer one', async () => {
    await opening('A')
    act(() => closeChatTab(chat, folder))
    folder = openPanelItem(chat, folderItem())!
    await opening('A')
    expect(isUnresolvedItem(page())).toBe(true)
    await withdraw('A')
    expect(isUnresolvedItem(page()), 'the newer open\'s waiting page stays').toBe(true)
    await answer('A')
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
  })

  it('6. a waiting page that could not be put up is said, and the answer still opens the file', async () => {
    await harness.render(null)
    await opening('A')
    act(() => closeChatTab(chat, folder))
    await harness.render(createElement(Panel, { chatId: chat }))
    await answer('A')
    expect(panelTabsOf(chat).find((each) => each.item.itemId === 'A')?.item).toMatchObject({ kind: 'workspace.file' })
  })

  it('the same file asked twice, the later answer first: one tab, both answers kept, nothing left waiting', async () => {
    await opening('A')
    const first = oldest('A')
    await opening('A')
    await answer('A')
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
    pending.set('A', [first!])
    noted.mockClear()
    await answer('A')
    await vi.waitFor(() => expect(noted).toHaveBeenCalledWith('workspace_note_open', { p_item_id: 'A' }))
    expect(panelTabsOf(chat)).toHaveLength(1)
    expect(panelTabsOf(chat).some((each) => isUnresolvedItem(each.item))).toBe(false)
  })

  it('the same file asked twice, the first open failing: its page goes, the second answer opens the file', async () => {
    await opening('A')
    await opening('A')
    await withdraw('A')
    expect(isFolderItem(page())).toBe(true)
    await answer('A')
    expect(panelTabsOf(chat).find((each) => each.item.itemId === 'A')?.item).toMatchObject({ kind: 'workspace.file' })
  })
})

// The small findings.
describe('review findings: the small ones', () => {
  it('the asking page\'s own state is kept on that page, not on the waiting page or the file that replaces it', async () => {
    await opening('A', { viewState: { scroll: 5 } })
    expect(history().pages[0]?.viewState).toEqual({ scroll: 5 })
    await answer('A', { viewState: { scroll: 5 } })
    expect(history().pages[1]?.viewState).toBeUndefined()
  })

  it('opened as a new tab (intent): it waits in a tab of its own and is the file there, the folder untouched', async () => {
    await opening('A', { intent: 'newTab' })
    expect(isFolderItem(page())).toBe(true)
    await answer('A', { intent: 'newTab' })
    expect(isFolderItem(page())).toBe(true)
    expect(panelTabsOf(chat).find((each) => each.tabId !== folder)?.item).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
  })

  it('a waiting page behind or ahead in a tab\'s history is never kept', async () => {
    await opening('A')
    await act(async () => { await chatPaneOf(chat, folder)!.go(folder, -1) })
    expect(JSON.stringify(chatLayoutOf(chat).snapshot)).not.toContain('"waitId"')
  })
})

// The phone's host resolves in the page's own host and tells the slot (GroupTabContent `onOpening`): the same waiting
// page, in the same tab; its answer comes through the chat's opener as the frame hands it.
describe('on the phone', () => {
  beforeEach(async () => { shell.mobile = true; await harness.render(createElement(Panel, { chatId: chat })) })
  afterEach(() => { shell.mobile = false })
  // As GroupTabContent wires the phone frame's `opening` and `openWith`: the open begins in this tab, its answer settles it.
  const phoneOpening = (itemId: string, openId: string) => act(async () => { beginTabFileOpen(chat, folder, openId, { itemId, intent: 'navigate' }); await new Promise<void>((done) => setTimeout(done, 0)) })
  const phoneAnswer = (itemId: string, openId: string) => act(async () => { panel.openWith!({ chatId: chat, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`, file: { document: false, contentType: 'text/markdown', version: 1, size: 3 }, choice: { kind: 'one', candidate: { extensionId: 'workspace', tabKind: 'workspace.file', tabTitle: 'Files', app: { name: 'Files' }, onlyTab: false, suffix: '.md' } }, intent: 'navigate', openId } as unknown as Detail, folder); await new Promise<void>((done) => setTimeout(done, 0)) })

  it('the waiting page fills the screen in the folder\'s place, then is the file there', async () => {
    await phoneOpening('A', 'phone-1')
    expect(chatLayoutOf(chat).narrow).toBe(true)
    expect(focusedChatTab(chat)).toMatchObject({ kind: 'panel', tabId: folder })
    expect(isUnresolvedItem(page())).toBe(true)
    await phoneAnswer('A', 'phone-1')
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
    expect(history().pages).toHaveLength(2)
  })

  it('2. the file is another chat\'s than the page\'s slot (its ref named that chat): the wait here is taken back', async () => {
    await phoneOpening('A', 'phone-3')
    expect(isUnresolvedItem(page())).toBe(true)
    await act(async () => { panel.openWith!({ chatId: other, itemId: 'A', name: 'A.md', typedName: 'A.md', file: { document: false, contentType: 'text/markdown', version: 1, size: 3 }, choice: { kind: 'none' }, intent: 'navigate', openId: 'phone-3' } as unknown as Detail, folder); await new Promise<void>((done) => setTimeout(done, 0)) })
    expect(isFolderItem(page())).toBe(true)
    expect(history().pages).toHaveLength(1)
    expect(takeChatAsk(other)).toMatchObject({ itemId: 'A', opener: { chatId: other } })
  })

  it('refused: back to the folder', async () => {
    await phoneOpening('A', 'phone-2')
    act(() => failFileOpen('phone-2'))
    expect(isFolderItem(page())).toBe(true)
    expect(history().pages).toHaveLength(1)
  })
})
