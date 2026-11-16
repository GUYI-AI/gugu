// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearViewState } from '../../../../apps/desktop/src/lib/viewStateTable'
import { followRendererSession } from '../../../../apps/desktop/src/lib/replica'
import { tellInstalled, type InstalledExtensionsList } from '../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions'
import { act } from 'react'
import { toJS } from 'mobx'
import { createReactHarness } from '../../../support/testHarness'
import { folderItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { openPanelItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { APP_OPEN_WITH_EVENT } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { ask, chatTabs, shownItem } from './chatTabsHarness'

/**
 * 最近打开 (gugu-supabase 20261017024605): a file the person opens in a group's panel is kept for them once
 * (`workspace_note_open`) — the panel showing it again when the person comes back to the group is not another open. And
 * an App's `files.openWith` for another chat's file is not this panel's to open: it goes to the chat shell
 * (`APP_OPEN_WITH_EVENT`, MainLayout), which brings that chat up.
 */
const rpc = vi.hoisted(() => vi.fn(async () => ({ data: null, error: null })))
const local = vi.hoisted(() => vi.fn(async (_item: string): Promise<unknown> => null))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', async original => ({ ...await original<typeof import('../../../../apps/desktop/src/lib/fileAccess')>(), localFileRevision: local }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: { rpc } }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: { kind: 'electron', capabilities: { appUpdates: false, notifications: false, rendererCommandBridge: false } },
}))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({
  appsHere: { runs: () => true, grantable: (manifest: unknown) => manifest, installAttachment: vi.fn(), marketOffers: vi.fn(async () => ({ success: true, data: [] })), onMarketChanged: () => () => {}, groupFileOpener: vi.fn(), groupFilesOpenedBy: vi.fn(async () => ({ success: true, data: [] })), setOpenWithDefault: vi.fn() },
}))
vi.mock('../../../../apps/desktop/src/components/extensionBundle/sharedPackages', async (original) => ({
  ...(await original<object>()),
  chatPackageCards: async () => (await import('./chatTabsHarness')).sharedCards.answer(),
}))

let harness: ReturnType<typeof createReactHarness>
const originalCheckVisibility = HTMLElement.prototype.checkVisibility
beforeEach(() => {
  // Signed in, as the harness's person (user-1): the group's shared packages are read for an account.
  followRendererSession('SIGNED_IN', 'user-1')
  harness = createReactHarness()
  HTMLElement.prototype.checkVisibility = () => false
  // What is installed here is read (as main tells it at start): nothing.
  tellInstalled('local', { extensions: [], invalid: [] } as unknown as InstalledExtensionsList)
  rpc.mockClear(); local.mockReset().mockResolvedValue(null)
})
// Where each resource last opened is the account's (tab-placement memory): each case starts with none remembered (after
// the setup above, whose closing of tabs is itself remembered).
beforeEach(() => { clearViewState({ conversation: '', panel: 'tab-placement' }) })
afterEach(() => {
  harness.cleanup()
  HTMLElement.prototype.checkVisibility = originalCheckVisibility
})

const detailOf = (chatId: string, itemId: string) => ({
  chatId, itemId, name: `${itemId}.pptx`, typedName: `${itemId}.pptx`,
  choice: { kind: 'one', candidate: { extensionId: 'office', tabKind: 'office.main', tabTitle: 'Office', app: { name: '咕咕办公' }, onlyTab: true, claim: '.pptx', suffix: '.pptx' } },
})
const askFile = (chatId: string, opener: ReturnType<typeof detailOf>) => ask(chatId, { itemId: opener.itemId, opener: opener as never })

describe('a file opened in a group\'s panel is kept for 最近打开, once', () => {
  it('carries an opening once without putting it or its callback into a tab snapshot', async () => {
    await harness.render(chatTabs({ chatId: 'g-opening' }))
    const opening = { entry: { id: 'once' }, epoch: 1, actor: 'person', expiresAt: 123 }
    askFile('g-opening', { ...detailOf('g-opening', 'once'), opening } as never)
    const item = shownItem('g-opening')!
    const snapshot = structuredClone(toJS(item))
    expect(snapshot).not.toHaveProperty('takeOpening')
    expect(snapshot).not.toHaveProperty('opening')
    expect(item.takeOpening!()).toEqual(opening)
    expect(item.takeOpening!()).toBeUndefined()
  })

  it('opened: one workspace_note_open with its id; shown again when the person comes back: no other', async () => {
    await harness.render(chatTabs({ chatId: 'g-note' }))
    askFile('g-note', detailOf('g-note', 'F1'))
    expect(shownItem('g-note')?.itemId).toBe('F1')
    await vi.waitFor(() => expect(rpc.mock.calls).toEqual([['workspace_note_open', { p_item_id: 'F1' }]]))
    // The person goes to another chat and comes back (the app still running: what it read is kept): F1 again, remembered.
    harness.cleanup({ keepReads: true })
    harness = createReactHarness()
    await harness.render(chatTabs({ chatId: 'g-note' }))
    expect(shownItem('g-note')?.itemId).toBe('F1')
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('a local file keeps its App tab without reporting the open to the cloud', async () => {
    local.mockResolvedValueOnce({ source: 'local', item_id: 'L1', chat_id: 'g-local' })
    await harness.render(chatTabs({ chatId: 'g-local' }))
    askFile('g-local', detailOf('g-local', 'L1'))
    expect(shownItem('g-local')?.itemId).toBe('L1')
    await vi.waitFor(() => expect(local).toHaveBeenCalledWith('L1'))
    await act(async () => {})
    expect(rpc).not.toHaveBeenCalled()
  })

  it('an App\'s own page in the panel (no file) is not a file opened: nothing kept', async () => {
    openPanelItem('g-page', folderItem())
    await harness.render(chatTabs({ chatId: 'g-page' }))
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('files.openWith for another chat\'s file goes to the chat shell', () => {
  it('this chat opens nothing and keeps nothing; the shell is told, with the host\'s answer', async () => {
    const heard: unknown[] = []
    const listen = (event: Event) => heard.push((event as CustomEvent).detail)
    window.addEventListener(APP_OPEN_WITH_EVENT, listen)
    try {
      const other = detailOf('g-other', 'F2')
      const page = { openWith: null as ReturnType<typeof useChatOpener>['openWith'] | null }
      const Page = () => {
        page.openWith = useChatOpener('g-here').openWith
        return null
      }
      await harness.render(<Page />)
      await act(async () => page.openWith!(other as never))
      expect(heard).toEqual([other])
      expect(shownItem('g-here')).toBe(null)
      expect(rpc).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener(APP_OPEN_WITH_EVENT, listen)
    }
  })
})

it('the shared-package mock is live (signed in): a file waits for this chat\'s packages, then is drawn', async () => {
  const { expectSharedPackagesLive } = await import('./chatTabsHarness')
  await expectSharedPackagesLive((node) => harness.render(node))
})
