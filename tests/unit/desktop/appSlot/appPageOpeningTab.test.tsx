// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'

/**
 * A file clicked in an App's page beside a chat (the chat's folder, an App's list): main hands the window a link to it
 * (`openChatFile`), and the window opens it as a file link opens — its waiting page as that page's next page in its tab,
 * turned into the file in place by the host's answer, taken back otherwise. Driven through the window's real action
 * handler, the real link layer and the chat's real opener; only the host's answer is held.
 */
vi.mock('@renderer/lib/stores/app-state', () => ({ appState: { navigation: { navigate: vi.fn(), currentViewId: 'chat' } } }))
vi.mock('@renderer/features/projects/stores/project-selectors', () => ({ getProjectManagerStore: () => ({ projects: new Map() }) }))
vi.mock('@renderer/features/sessions/acp/acp-chat-tab-resource', () => ({ AcpChatTabResource: class {} }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: async () => null }))
/** Each answer that comes to a page is kept as opened (最近打开): how an answer not dropped shows. */
const noted = vi.hoisted(() => vi.fn(async () => ({ error: null })))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc: noted } }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: vi.fn(), runs: () => true } }))

const { applyExtensionHostAction } = await import('@renderer/features/extensions/host-action-handlers')
const { askChatFile, chatLayoutOf, closeChatTab, openPanelItem, panelTabsOf, takeChatAsk, chatPaneOf } = await import('@renderer/features/chats/chat-tabs/chat-layouts')
const { folderItem, groupPageSlot, isFolderItem, isWaitingItem } = await import('@renderer/features/chats/chat-tabs/chat-panel-item')
const { useChatOpener } = await import('../../../../apps/desktop/src/components/appSlot/useChatOpener')
const { useLinkNavigation } = await import('../../../../apps/desktop/src/hooks/useLinkNavigation')
const { appsHere } = await import('../../../../apps/desktop/src/components/appSlot/appsHere')
const { displayNameOf } = await import('../../../../apps/desktop/src/session/shared/extensions/file-openers')
type Detail = import('../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol').AppOpenWithDetail

let serial = 0
let chat = '', other = '', folder = ''
let harness: ReturnType<typeof createReactHarness>
/** The chat shell (its link layer, handing answers to the chat as MainLayout does) and the chat's panel. */
function Shell() {
  useLinkNavigation({ ownerId: 'owner', chats: () => [{ id: chat, kind: 'group' }, { id: other, kind: 'group' }] as never, contacts: () => [],
    openChat() {}, openApp() {}, openOwnApp() {}, openProject() {}, openAssistant() {},
    openFile: (chatId, target, source, opener) => askChatFile(chatId, { itemId: target.itemId, opener, ...(source.message ? { message: source.message } : {}) }),
  })
  const opener = useChatOpener(chat)
  panel.openWith = opener.openWith
  return createElement('div', null, opener.overlay)
}
/** The chat's opener, as an App's list beside the chat hands it a file it resolved itself (`openWith`). */
const panel = { openWith: null as null | ((detail: Detail) => void) }
/** The host's answers, held per file until the test lets each go. */
const held = new Map<string, (answer: Detail | { error: string; code?: string }) => void>()
const preview = (itemId: string, chatId = chat): Detail => ({ chatId, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`, file: { document: false, contentType: 'text/markdown', version: 1, size: 3 }, choice: { kind: 'one', candidate: { extensionId: 'workspace', tabKind: 'workspace.file', tabTitle: 'Files', app: { name: 'Files' }, onlyTab: false, suffix: '.md' } } } as Detail)
/** What main sends for the page in the folder tab, through the window's handler as the bridge's relay delivers it. */
const outcomes = new Map<string, Promise<string>>()
const opening = async (itemId: string, extra: Record<string, unknown> = {}) => {
  let done!: Promise<unknown>
  await act(async () => { done = Promise.resolve(applyExtensionHostAction({ origin: { pageId: null, extensionId: 'workspace', sessionId: null, tabId: groupPageSlot(chat, folder) }, action: { kind: 'openChatFile', itemId, intent: 'navigate', ...extra } as never })) })
  outcomes.set(itemId, done.then(() => 'opened', (error: { code?: string; message: string }) => error.code ? `failed: ${error.code}` : `failed: ${error.message}`))
  await until(`${itemId} is asked of the host`, () => held.has(itemId))
}
const answer = async (itemId: string, how: Detail | { error: string; code?: string } = preview(itemId)) => {
  await act(async () => { held.get(itemId)!(how); held.delete(itemId); await new Promise<void>((done) => setTimeout(done, 0)) })
}
const page = () => panelTabsOf(chat).find((tab) => tab.tabId === folder)?.item
const history = () => chatPaneOf(chat, folder)!.navigationOf(folder)!

beforeEach(async () => {
  harness = createReactHarness()
  chat = `app-opening-${++serial}`; other = `app-opening-other-${serial}`
  held.clear(); outcomes.clear(); noted.mockClear()
  vi.mocked(appsHere!.groupFileOpener).mockReset().mockImplementation(({ itemId }) => new Promise((resolve) => held.set(itemId, (how) => resolve(('error' in how ? { success: false, ...how } : { success: true, data: how }) as never))))
  folder = openPanelItem(chat, folderItem())!
  await harness.render(createElement(Shell))
})
afterEach(() => {
  for (const tab of panelTabsOf(chat)) closeChatTab(chat, tab.tabId)
  harness.cleanup()
})

describe('a file clicked in the chat\'s folder', () => {
  it('waits as the folder tab\'s next page, titled by the page\'s name, then is that file in place: Back to the folder', async () => {
    await opening('A', { fileName: 'A.md' })
    expect(panelTabsOf(chat)).toHaveLength(1)
    expect(isWaitingItem(page())).toBe(true)
    expect(page()?.title).toBe('A.md')
    expect(history().pages).toHaveLength(2)
    await answer('A')
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A', title: displayNameOf('A.md', '.md') })
    expect(history().pages).toHaveLength(2)
    expect(await outcomes.get('A')).toBe('opened')
    await act(async () => { await chatPaneOf(chat, folder)!.go(folder, -1) })
    expect(isFolderItem(page())).toBe(true)
  })

  it('refused: back to the folder, no waiting page in Back or Forward; the page is told why by its code', async () => {
    await opening('A')
    await answer('A', { error: 'No such file in this chat', code: 'not-found' })
    expect(isFolderItem(page())).toBe(true)
    expect(history().pages).toHaveLength(1)
    expect(chatPaneOf(chat, folder)!.canGo(folder, 1)).toBe(false)
    expect(await outcomes.get('A')).toBe('failed: not-found')
  })

  it('a failure with no code (offline): said as it is, no code made up', async () => {
    await opening('A')
    await answer('A', { error: 'fetch failed' })
    expect(await outcomes.get('A')).toBe('failed: fetch failed')
  })

  it('who opens it is for the person to pick: the waiting page goes, the pick is offered', async () => {
    await opening('A')
    const candidate = (extensionId: string) => ({ extensionId, tabKind: `${extensionId}.file`, tabTitle: extensionId, app: { name: extensionId, defaultLocale: 'en' }, onlyTab: false, suffix: '.md' })
    await answer('A', { ...preview('A'), choice: { kind: 'choose', suffix: '.md', candidates: [candidate('workspace'), candidate('notes')] } } as never)
    await until('the waiting page is gone', () => isFolderItem(page()))
    expect(history().pages).toHaveLength(1)
    expect(harness.container.textContent, 'the pick is offered over the chat').toContain('notes')
  })

  it('another chat\'s file: nothing waits here, that chat is handed the file', async () => {
    await opening('A')
    await answer('A', preview('A', other))
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
    // The person moved on: nothing failed, so the page that asked for A is told nothing went wrong.
    expect(await outcomes.get('A')).toBe('opened')
    expect(await outcomes.get('B')).toBe('opened')
  })

  it('A waiting, then a file opened straight from an App\'s list: A gives way, and its page hears no error', async () => {
    await opening('A')
    await act(async () => { panel.openWith!(preview('C')); await new Promise<void>((done) => setTimeout(done, 0)) })
    await answer('A')
    expect(panelTabsOf(chat).some((each) => each.item.itemId === 'A')).toBe(false)
    expect(await outcomes.get('A')).toBe('opened')
  })
})

// The independent review of 80a6b15d37, each finding as it shows on screen.
describe('review findings', () => {
  it('1. opening a file already open here: that tab in front, and the answer still goes to it', async () => {
    await opening('A'); await answer('A')
    await opening('A')
    expect(panelTabsOf(chat).some((each) => isWaitingItem(each.item)), 'no waiting page: it is open already').toBe(false)
    noted.mockClear()
    await answer('A')
    await vi.waitFor(() => expect(noted).toHaveBeenCalledWith('workspace_note_open', { p_item_id: 'A' }))
    expect(panelTabsOf(chat)).toHaveLength(1)
  })

  it('3. Back from the waiting page: its answer opens nothing, and Forward does not reach a page that waits forever', async () => {
    await opening('A')
    await act(async () => { await chatPaneOf(chat, folder)!.go(folder, -1) })
    await answer('A')
    expect(isFolderItem(page())).toBe(true)
    expect(chatPaneOf(chat, folder)!.canGo(folder, 1)).toBe(false)
    expect(history().pages).toHaveLength(1)
    expect(await outcomes.get('A'), 'going back is no failure the page is told of').toBe('opened')
  })

  it('4. opened in a tab of its own, the asking App tab closed meanwhile: taken back all the same', async () => {
    await opening('A', { intent: 'newTab' })
    const waiting = panelTabsOf(chat).find((each) => isWaitingItem(each.item))!.tabId
    expect(waiting).not.toBe(folder)
    act(() => closeChatTab(chat, folder))
    await answer('A', { error: 'gone', code: 'not-found' })
    expect(panelTabsOf(chat).map((each) => each.tabId)).not.toContain(waiting)
  })

  it('5. an earlier open failing late takes back only its own wait, never the newer one in its place', async () => {
    await opening('A')
    await opening('B')
    await answer('A', { error: 'gone', code: 'not-found' })
    expect(page()).toMatchObject({ itemId: 'B' })
    expect(isWaitingItem(page()), 'B\'s waiting page stays').toBe(true)
    await answer('B')
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'B' })
  })

  it('6. a waiting page that could not be put up (the chat not drawn): the answer still opens the file', async () => {
    await harness.render(null)
    await harness.render(createElement(function LinksOnly() {
      useLinkNavigation({ ownerId: 'owner', chats: () => [{ id: chat, kind: 'group' }] as never, contacts: () => [],
        openChat() {}, openApp() {}, openOwnApp() {}, openProject() {}, openAssistant() {},
        openFile: (chatId, target, _source, opener) => askChatFile(chatId, { itemId: target.itemId, opener }) })
      return null
    }))
    await opening('A')
    await act(async () => { held.get('A')!(preview('A')); held.delete('A') })
    await harness.render(createElement(Shell))
    await until('the file is open', () => panelTabsOf(chat).some((each) => each.item.kind === 'workspace.file'))
    expect(panelTabsOf(chat).some((each) => isWaitingItem(each.item))).toBe(false)
  })
})

// Given up on purpose: the waiting page carries its own identity and nothing records whether it was ever shown, so a
// person closing it does not cancel the open — the answer still opens the file, as before the waiting page existed.
describe('the waiting page closed by the person', () => {
  it('waiting in place in the folder\'s tab, that tab closed: nothing opens, the tab it was to open beside being gone', async () => {
    await opening('A')
    act(() => closeChatTab(chat, folder))
    await answer('A')
    expect(panelTabsOf(chat)).toEqual([])
    // As it stands the page that asked is told the panel could not open it.
    expect(await outcomes.get('A')).toBe('failed: The file panel could not be opened')
  })

  it('waiting in a tab of its own (newTab), that tab closed: the answer still opens the file', async () => {
    await opening('A', { intent: 'newTab' })
    const waiting = panelTabsOf(chat).find((each) => isWaitingItem(each.item))!.tabId
    act(() => closeChatTab(chat, waiting))
    await answer('A')
    expect(panelTabsOf(chat).some((each) => each.item.itemId === 'A' && each.item.kind === 'workspace.file')).toBe(true)
  })
})

describe('the small ones', () => {
  it('the asking page\'s own state is kept on that page, not on the waiting page or the file that replaces it', async () => {
    await opening('A', { viewState: { scroll: 5 } })
    expect(history().pages[0]?.viewState).toEqual({ scroll: 5 })
    await answer('A')
    expect(history().pages[0]?.viewState).toEqual({ scroll: 5 })
    expect(history().pages[1]?.viewState).toBeUndefined()
  })

  it('opened as a new tab (intent): it waits in a tab of its own and is the file there, the folder untouched', async () => {
    await opening('A', { intent: 'newTab' })
    expect(isFolderItem(page())).toBe(true)
    await answer('A')
    expect(isFolderItem(page())).toBe(true)
    expect(panelTabsOf(chat).find((each) => each.tabId !== folder)?.item).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
  })

  it('a waiting page behind or ahead in a tab\'s history is never kept', async () => {
    await opening('A')
    await act(async () => { await chatPaneOf(chat, folder)!.go(folder, -1) })
    expect(JSON.stringify(chatLayoutOf(chat).snapshot)).not.toContain('"waitId"')
    await answer('A', { error: 'gone' })
  })
})
