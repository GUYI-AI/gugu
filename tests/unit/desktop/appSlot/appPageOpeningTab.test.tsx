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
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc: async () => ({ error: null }) } }))
const shell = vi.hoisted(() => ({ mobile: false }))
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', async (original) => ({ ...await original<object>(), useMobileShell: () => shell.mobile }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: vi.fn(), runs: () => true } }))

const { applyExtensionHostAction } = await import('@renderer/features/extensions/host-action-handlers')
const { askChat, askFileOpen, closeUnresolved, chatLayoutOf, closeChatTab, focusedChatTab, openPanelItem, panelTabsOf, takeChatAsk, chatPaneOf } = await import('@renderer/features/chats/chat-tabs/chat-layouts')
const { folderItem, groupPageSlot, isFolderItem, isUnresolvedItem } = await import('@renderer/features/chats/chat-tabs/chat-panel-item')
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
const opening = (itemId: string, extra: Record<string, unknown> = {}) => send({ kind: 'openingChatFile', itemId, intent: 'navigate', ...extra })
const answer = (itemId: string, extra: Partial<Detail> = {}, announced = true) => send({ kind: 'openWith', detail: {
  chatId: chat, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`, file: { document: false, contentType: 'text/markdown', version: 1, size: 3 },
  choice: { kind: 'one', candidate: { extensionId: 'workspace', tabKind: 'workspace.file', tabTitle: 'Files', app: { name: 'Files' }, onlyTab: false, suffix: '.md' } }, intent: 'navigate',
  ...(announced ? { announced: true } : {}), ...extra,
} })
let folder = ''
const page = () => panelTabsOf(chat).find((tab) => tab.tabId === folder)?.item
const history = () => chatPaneOf(chat, folder)!.navigationOf(folder)!

beforeEach(async () => {
  harness = createReactHarness()
  chat = `app-opening-${++serial}`; other = `app-opening-other-${serial}`
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
    await send({ kind: 'openingChatFile', itemId: 'A', intent: 'navigate', withdrawn: true })
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
    await send({ kind: 'openingChatFile', itemId: 'A', intent: 'navigate', withdrawn: true })
    await answer('A', { chatId: other }, false)
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

// The phone's host resolves in the page's own host and tells the slot (GroupTabContent `onOpening`): the same waiting
// page, in the same tab; its answer comes through the chat's opener as the frame hands it.
describe('on the phone', () => {
  beforeEach(async () => { shell.mobile = true; await harness.render(createElement(Panel, { chatId: chat })) })
  afterEach(() => { shell.mobile = false })
  const phoneOpening = (itemId: string) => act(async () => { void askFileOpen(chat, { itemId }, { from: folder, intent: 'navigate' }, null).catch(() => undefined); await new Promise<void>((done) => setTimeout(done, 0)) })
  const phoneAnswer = (itemId: string) => act(async () => { panel.openWith!({ chatId: chat, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`, file: { document: false, contentType: 'text/markdown', version: 1, size: 3 }, choice: { kind: 'one', candidate: { extensionId: 'workspace', tabKind: 'workspace.file', tabTitle: 'Files', app: { name: 'Files' }, onlyTab: false, suffix: '.md' } }, intent: 'navigate', announced: true } as Detail, folder); await new Promise<void>((done) => setTimeout(done, 0)) })

  it('the waiting page fills the screen in the folder\'s place, then is the file there', async () => {
    await phoneOpening('A')
    expect(chatLayoutOf(chat).narrow).toBe(true)
    expect(focusedChatTab(chat)).toMatchObject({ kind: 'panel', tabId: folder })
    expect(isUnresolvedItem(page())).toBe(true)
    await phoneAnswer('A')
    expect(page()).toMatchObject({ kind: 'workspace.file', itemId: 'A' })
    expect(history().pages).toHaveLength(2)
  })

  it('refused: back to the folder', async () => {
    await phoneOpening('A')
    act(() => closeUnresolved(chat, 'A'))
    expect(isFolderItem(page())).toBe(true)
    expect(history().pages).toHaveLength(1)
    await phoneAnswer('A')
    expect(isFolderItem(page()), 'a late answer to the taken-back wait opens nothing').toBe(true)
  })
})
