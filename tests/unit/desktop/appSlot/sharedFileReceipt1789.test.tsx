// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { until } from '../../../support/awaitCondition'
import { useLinkNavigation } from '../../../../apps/desktop/src/hooks/useLinkNavigation'
import { isUnresolvedItem } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-panel-item'
import { OpenSuperseded, openLinkTarget } from '../../../../apps/desktop/src/lib/guguLinks'
import { useChatOpener } from '../../../../apps/desktop/src/components/appSlot/useChatOpener'
import { askChat, askChatFile, panelTabsOf, askFileOpen } from '../../../../apps/desktop/src/session/renderer/features/chats/chat-tabs/chat-layouts'
import { UI_EVENTS } from '../../../../apps/desktop/src/lib/uiEvents'
import type { AppOpenWithDetail } from '../../../../apps/desktop/src/session/shared/extensions/app-runtime-protocol'

const state = vi.hoisted(() => ({ chat: '', resolve: vi.fn(), note: vi.fn(), local: vi.fn(), from: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: { kind: 'electron', capabilities: {} } }))
vi.mock('../../../../apps/desktop/src/lib/fileAccess', () => ({ localFileRevision: state.local }))
vi.mock('../../../../apps/desktop/src/components/appSlot/appsHere', () => ({ appsHere: { groupFileOpener: state.resolve } }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {
  rpc: state.note,
  from: (table: string) => {
    state.from(table)
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: { chat_id: state.chat }, error: null }) }
    return query
  },
} }))

let serial = 0
let harness: ReturnType<typeof createReactHarness>
const onShow = vi.fn<(_chat: string, _tab: string) => void | Promise<void>>()
function Entry() {
  useLinkNavigation({ ownerId: 'owner', chats: () => [{ id: state.chat, kind: 'group' }] as never, contacts: () => [],
    openChat() {}, openAssistant() {}, openApp() {}, openOwnApp() {}, openProject() {},
    currentChat: () => state.chat, openFile: (chat, target, source, opener) => askFileOpen(chat, target, source, opener),
  })
  return useChatOpener(state.chat, onShow).overlay
}
function detail(itemId = 'file'): AppOpenWithDetail {
  return { chatId: state.chat, itemId, name: `${itemId}.md`, typedName: `${itemId}.md`,
    choice: { kind: 'one', candidate: { tabKind: 'workspace.file', suffix: '.md' } } } as AppOpenWithDetail
}
function link(itemId = 'file') {
  const opened = openLinkTarget({ kind: 'file', itemId })
  void opened.catch(() => undefined)
  return opened
}
beforeEach(() => {
  harness = createReactHarness()
  state.chat = `file-receipt-1789-${++serial}`
  state.resolve.mockReset(); state.note.mockReset(); state.local.mockReset(); state.from.mockReset(); onShow.mockReset()
  state.local.mockResolvedValue(null)
  state.note.mockResolvedValue({ error: null })
})
afterEach(() => harness.cleanup())

it('keeps the real link pending until its file is resolved and its native panel accepts it', async () => {
  let resolveFile!: (value: unknown) => void, showPanel!: () => void
  state.resolve.mockImplementation(() => new Promise(resolve => { resolveFile = resolve }))
  onShow.mockImplementation(() => new Promise<void>(resolve => { showPanel = resolve }))
  await harness.render(<Entry />)
  let outcome = 'pending'
  const opened = link().then(() => { outcome = 'opened' })
  // The file's tab is up with the click, waiting on the host, and its native panel asked for — the link not yet answered.
  const waiting = panelTabsOf(state.chat)
  expect(waiting).toHaveLength(1)
  expect(isUnresolvedItem(waiting[0]!.item)).toBe(true)
  await act(async () => { await until('file resolution started', () => state.resolve.mock.calls.length === 1) })
  expect(outcome).toBe('pending')
  expect(onShow.mock.calls.map(([, tab]) => tab)).toEqual([waiting[0]!.tabId])
  await act(async () => { resolveFile({ success: true, data: detail() }); await until('native panel was requested for the real page', () => onShow.mock.calls.length === 2) })
  expect(outcome).toBe('pending')
  expect(state.note).not.toHaveBeenCalled()
  // The same tab, now the real page.
  expect(panelTabsOf(state.chat).map((tab) => tab.tabId)).toEqual([waiting[0]!.tabId])
  expect(panelTabsOf(state.chat)[0]?.item).toMatchObject({ kind: 'workspace.file', itemId: 'file' })
  expect(onShow.mock.calls.map(([, tab]) => tab)).toEqual([waiting[0]!.tabId, waiting[0]!.tabId])
  await act(async () => { showPanel(); await opened })
  expect(outcome).toBe('opened')
  await until('the accepted file is recorded as opened', () => state.note.mock.calls.length === 1)
  // One answer from the host: the file's chat came with it, nothing read in the renderer to find it.
  expect(state.resolve).toHaveBeenCalledExactlyOnceWith({ itemId: 'file' })
  expect(state.local, 'no localFileRevision for the file\'s chat (noteOpened reads it after the open)').toHaveBeenCalledTimes(1)
  expect(state.from).not.toHaveBeenCalled()
})

it.each(['refused', 'transport rejection'])('returns a file %s to the original link without a duplicate failure surface', async mode => {
  if (mode === 'refused') state.resolve.mockResolvedValue({ success: false, error: 'file disappeared' })
  else state.resolve.mockRejectedValue(new Error('file host disconnected'))
  await harness.render(<Entry />)
  await act(async () => { await expect(link()).rejects.toThrow() })
  expect(harness.container.querySelector('[data-testid="group-app-slot-unopened"]')).toBeNull()
  // Its waiting tab was up (its native panel asked for once), and is gone with the failure.
  expect(panelTabsOf(state.chat)).toHaveLength(0)
  expect(onShow).toHaveBeenCalledOnce()
  expect(state.note).not.toHaveBeenCalled()
})

it('propagates native placement rejection instead of recording the file as opened', async () => {
  state.resolve.mockResolvedValue({ success: true, data: detail() })
  onShow.mockRejectedValue(new Error('native resource host unavailable'))
  await harness.render(<Entry />)
  await act(async () => { await expect(link()).rejects.toThrow() })
  expect(harness.container.querySelector('[data-testid="group-app-slot-unopened"]')).toBeNull()
  expect(state.note).not.toHaveBeenCalled()
})

it('keeps the inline failure surface for a direct folder request without a link caller', async () => {
  onShow.mockRejectedValue(new Error('native resource host unavailable'))
  await harness.render(<Entry />)
  await act(async () => {
    askChat(state.chat, { itemId: 'file', opener: detail() })
    window.dispatchEvent(new CustomEvent(UI_EVENTS.chatAsked, { detail: { chatId: state.chat } }))
  })
  expect(harness.container.querySelector('[data-testid="group-app-slot-unopened"]')).not.toBeNull()
  expect(state.resolve, 'answered already: the panel does not ask the host again').not.toHaveBeenCalled()
})

it('takes a cold file request when its consumer mounts without acknowledging the mailbox alone', async () => {
  let outcome = 'pending'
  const opened = askChatFile(state.chat, { itemId: 'file', opener: detail() }).then(() => { outcome = 'opened' })
  expect(outcome).toBe('pending')
  expect(state.resolve).not.toHaveBeenCalled()
  await harness.render(<Entry />)
  await opened
  expect(outcome).toBe('opened')
  expect(onShow).toHaveBeenCalledOnce()
  expect(state.resolve, 'the opener came with the ask').not.toHaveBeenCalled()
})

it('rejects an unmounted consumer and ignores its late successful result', async () => {
  let finish!: (value: unknown) => void
  state.resolve.mockImplementation(() => new Promise(resolve => { finish = resolve }))
  await harness.render(<Entry />)
  const opened = link()
  await act(async () => { await until('file resolution started', () => state.resolve.mock.calls.length === 1) })
  await harness.render(null)
  // Unmounted while the link layer still waits on the host: no panel holds a receipt yet, so nothing has rejected it.
  let settled = 'pending'
  void opened.then(() => { settled = 'resolved' }, () => { settled = 'rejected' })
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(settled, 'held by the link layer awaiting its host, not by a panel').toBe('pending')
  // The answer arriving after the shell is gone opens nothing: the link is told it was superseded, not that it failed.
  await act(async () => { finish({ success: true, data: detail() }) })
  await expect(opened).rejects.toBeInstanceOf(OpenSuperseded)
  // The waiting tab it had opened is gone too; nothing was opened for the late answer.
  expect(panelTabsOf(state.chat)).toHaveLength(0)
  expect(onShow).toHaveBeenCalledOnce()
})

it('does not replace the latest file with an older result or claim the older link succeeded', async () => {
  let finishFirst!: (value: unknown) => void
  state.resolve.mockImplementationOnce(() => new Promise(resolve => { finishFirst = resolve }))
    .mockResolvedValueOnce({ success: true, data: detail('second') })
  await harness.render(<Entry />)
  const first = link('first')
  await act(async () => { await until('first file resolution started', () => state.resolve.mock.calls.length === 1) })
  await act(async () => { await link('second') })
  // The first's answer comes back after: it opens nothing, and its link is told it was superseded — not that it opened.
  await act(async () => { finishFirst({ success: true, data: detail('first') }) })
  await expect(first).rejects.toBeInstanceOf(OpenSuperseded)
  expect(panelTabsOf(state.chat).map(tab => tab.item.itemId)).toEqual(['second'])
  // One tab all along: the first's waiting tab, the second's in its place, then the second itself.
  const tab = panelTabsOf(state.chat)[0]!.tabId
  expect(onShow.mock.calls.map(([, shown]) => shown)).toEqual([tab, tab, tab])
})

it('refuses a resolver response for another conversation without opening its file', async () => {
  state.resolve.mockResolvedValue({ success: true, data: { ...detail(), chatId: 'other-chat' } })
  await harness.render(<Entry />)
  await act(async () => { await expect(link()).rejects.toThrow() })
  expect(state.resolve).toHaveBeenCalledExactlyOnceWith({ itemId: 'file' })
  // The tab that waited here goes: the file is another chat's.
  expect(panelTabsOf(state.chat)).toHaveLength(0)
  expect(onShow).toHaveBeenCalledOnce()
})

it('joins a second ask for the same file while the first is opening: the host answers once, both links resolve, one tab', async () => {
  let resolveFile!: (value: unknown) => void
  state.resolve.mockImplementation(() => new Promise(resolve => { resolveFile = resolve }))
  await harness.render(<Entry />)
  const outcomes: string[] = []
  const first = link().then(() => outcomes.push('first opened'), () => outcomes.push('first rejected'))
  await act(async () => { await until('file resolution started', () => state.resolve.mock.calls.length === 1) })
  const again = link().then(() => outcomes.push('again opened'), () => outcomes.push('again rejected'))
  await act(async () => { resolveFile({ success: true, data: detail() }); await first; await again })
  expect(outcomes.sort()).toEqual(['again opened', 'first opened'])
  expect(state.resolve).toHaveBeenCalledOnce()
  expect(panelTabsOf(state.chat)).toHaveLength(1)
  // The second click opened no second waiting tab: the one tab, waiting, then real.
  expect(onShow).toHaveBeenCalledTimes(2)
})

// The panel took the ask (its receipt held, the native panel not yet up) and then went away: the caller is told at once.
it.each(['direct ask', 'link'])('rejects at once when the panel holding the %s unmounts', async (way) => {
  state.resolve.mockResolvedValue({ success: true, data: detail() })
  onShow.mockImplementation(() => new Promise<void>(() => {}))
  await harness.render(<Entry />)
  const opened = way === 'link' ? link() : askChatFile(state.chat, { itemId: 'file', opener: detail() })
  void opened.catch(() => undefined)
  // A link's file goes up waiting first (one native panel ask), then the answer (the second): the panel holds that one.
  await act(async () => { await until('the panel took the ask', () => onShow.mock.calls.length === (way === 'link' ? 2 : 1)) })
  await harness.render(null)
  const error = await opened.then(() => null, (reason: unknown) => reason) as Error & { cause?: Error }
  const closed = way === 'link' ? error.cause : error
  expect(closed?.message).toBe('The file opener was closed')
})
