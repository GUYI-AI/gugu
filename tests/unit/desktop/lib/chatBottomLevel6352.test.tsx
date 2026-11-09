// @vitest-environment jsdom
// #6352 「读者在底部」是电平:门打开 / 几何变化到底时要重读,不能只认那一次边沿。
// 产品面读数(mac1,长历史群聊):① 未读定位打开、全部未读已在屏内 ⇒ Virtuoso 在「定位中」那一刻
// 报过一次到底,之后不再报;② 快速滚回底部,最后一次 scroll 停在阈值外、列表量完变矮才到底 ⇒ 没有
// scroll 事件。两种都让窗口以为读者在翻历史,自己发一条就回到最新页、整表重挂(闪)。
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createNode, createReactHarness } from '../../../support/testHarness'
import { useFollowingTail, useTailPinning } from '../../../../apps/desktop/src/components/chat/useFollowingTail'
import { useChatHistoryPagination } from '../../../../apps/desktop/src/components/chat/useChatHistoryPagination'
import { ChatHistoryWindow, HISTORY_START_INDEX, type HistoryWindow } from '../../../../apps/desktop/src/store/chatHistoryWindow'
import { message } from '../../../support/testHarness'
import { MESSAGE_WINDOW } from '../../../../apps/desktop/src/store/chatMessageWindow'
import type { FlowListHandle } from '../../../../apps/desktop/src/lib/flowList'

function setMountedRange(scroller: HTMLElement, first = 1, last = 120) {
  const content = document.createElement('div')
  for (const position of [first, last]) {
    const row = document.createElement('div')
    row.setAttribute('aria-posinset', String(position)); row.setAttribute('aria-setsize', '120')
    content.appendChild(row)
  }
  scroller.replaceChildren(content)
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness() })
afterEach(() => { harness.cleanup() })

describe('following the tail is derived from the at-bottom level', () => {
  async function setup() {
    const setFollowingTail = vi.fn()
    const isAtBottomRef = { current: false }
    const input = { resetKey: 'chat-1#0#1', unreadNavigationPending: true, hasNewer: false, loading: false, preserving: false }
    let onAtBottomChange: (atBottom: boolean) => void = () => {}
    function Probe() {
      onAtBottomChange = useFollowingTail({ ...input, isPreservingPosition: () => input.preserving, isAtBottomRef, setFollowingTail }).onAtBottomChange
      return null
    }
    const render = () => harness.render(createNode(Probe))
    await render()
    return { setFollowingTail, isAtBottomRef, input, render, report: (atBottom: boolean) => act(async () => { onAtBottomChange(atBottom) }) }
  }

  it('rejoins the tail when the unread-navigation gate opens after the only at-bottom report', async () => {
    const view = await setup()
    await view.report(true) // the list reports once, while the unread locator is still pending
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
    view.input.unreadNavigationPending = false
    await view.render() // no second report: the reader never moved
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(true)
    expect(view.isAtBottomRef.current).toBe(true)
  })

  it('stays off the tail when the gate opens but the reader is not at the bottom (control)', async () => {
    const view = await setup()
    await view.report(false)
    view.input.unreadNavigationPending = false
    await view.render()
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
    expect(view.isAtBottomRef.current).toBe(false)
  })

  it('keeps a reader restored to a saved off-bottom position off the tail when a gate flips afterwards', async () => {
    const view = await setup()
    view.input.unreadNavigationPending = false
    view.input.preserving = true // reopening a chat whose saved position is up in history
    await view.render()
    await view.report(true) // the list opens at LAST first ...
    await view.report(false) // ... then the restore scrolls it to the saved anchor
    view.setFollowingTail(false) // the restore ends by leaving the tail itself
    view.input.preserving = false
    view.input.loading = true // the reader then loads an older page
    await view.render()
    view.input.loading = false
    await view.render()
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
  })

  it('rejoins when the last newer page clears hasNewer under a reader already at the bottom', async () => {
    const view = await setup()
    view.input.unreadNavigationPending = false
    view.input.hasNewer = true
    await view.render()
    await view.report(true)
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(false)
    view.input.hasNewer = false
    await view.render()
    expect(view.setFollowingTail).toHaveBeenLastCalledWith(true)
  })
})

describe('the newer page is requested from the at-bottom level, not only from scroll events', () => {
  function historyWindow(): HistoryWindow {
    const messages = Array.from({ length: 120 }, (_, index) => ({ id: `m${index + 11}`, seq: index + 11 })) as HistoryWindow['messages']
    return { chatId: 'chat-1', messages, firstItemIndex: HISTORY_START_INDEX, hasOlder: true, hasNewer: true, loading: null,
      change: 'older', navigation: 'older', navigationVersion: 4, viewVersion: 1, newMessageCount: 0, latestSeen: 200 }
  }
  function scrollerAt(fromBottom: number): HTMLElement {
    const element = document.createElement('div')
    setMountedRange(element)
    Object.defineProperty(element, 'scrollHeight', { value: 11_503 })
    Object.defineProperty(element, 'clientHeight', { value: 776 })
    element.scrollTop = 11_503 - 776 - fromBottom
    return element
  }
  async function setup(fromBottom: number) {
    const loadNewer = vi.fn(async () => {})
    const loadOlder = vi.fn(async () => {})
    const input = { atBottom: false }
    const window = historyWindow()
    const scroller = scrollerAt(fromBottom)
    function Probe() {
      useChatHistoryPagination({ resetKey: 'chat-1#0#1', messages: window.messages, enabled: true, scroller, atBottom: input.atBottom, loadOlder, loadNewer, window })
      return null
    }
    const render = () => harness.render(createNode(Probe))
    await render()
    return { loadNewer, loadOlder, input, render }
  }

  it('loads newer when the list shrinks the reader onto the bottom without a scroll event', async () => {
    const view = await setup(0)
    expect(view.loadNewer).not.toHaveBeenCalled()
    view.input.atBottom = true
    await view.render()
    expect(view.loadNewer).toHaveBeenCalledOnce()
    expect(view.loadOlder).not.toHaveBeenCalled()
  })

  it('does not load newer from a stale level while the geometry is away from the bottom (control)', async () => {
    const view = await setup(1_400)
    view.input.atBottom = true
    await view.render()
    expect(view.loadNewer).not.toHaveBeenCalled()
    expect(view.loadOlder).not.toHaveBeenCalled()
  })
})

describe('pagination does not measure layout when no page can be requested', () => {
  async function setup({ hasNewer = false, loadNewerPresent = true, loading = false, atBottom = true, firstSeq = 11, scrollTop = 10_000 } = {}) {
    const scrollHeight = vi.fn(() => 11_503)
    const clientHeight = vi.fn(() => 776)
    const scroller = document.createElement('div')
    setMountedRange(scroller)
    Object.defineProperties(scroller, { scrollHeight: { get: scrollHeight }, clientHeight: { get: clientHeight } })
    scroller.scrollTop = scrollTop
    const loadOlder = vi.fn(async () => {})
    const loadNewer = vi.fn(async () => {})
    const window: HistoryWindow = { chatId: 'chat-1', messages: [{ id: 'm-first', seq: firstSeq }] as HistoryWindow['messages'],
      firstItemIndex: HISTORY_START_INDEX, hasOlder: firstSeq !== 1, hasNewer, loading: loading ? 'newer' : null,
      change: 'reset', navigation: 'reset', navigationVersion: 0, viewVersion: 1, newMessageCount: 0, latestSeen: 200 }
    function Probe() {
      useChatHistoryPagination({ resetKey: 'chat-1#0#1', messages: window.messages, enabled: true, scroller, atBottom,
        loadOlder: () => loadOlder(), loadNewer: loadNewerPresent ? () => loadNewer() : undefined, window })
      return null
    }
    const render = () => harness.render(createNode(Probe))
    await render()
    return { window, render, scrollHeight, clientHeight, loadOlder, loadNewer, scroller }
  }

  it('does not synchronously read dimensions on incoming tail updates when there is no newer page', async () => {
    const view = await setup()
    for (let seq = 12; seq < 22; seq++) {
      view.window.messages = [...view.window.messages, { id: `m${seq}`, seq } as HistoryWindow['messages'][number]]
      await view.render()
    }
    expect(view.scrollHeight).not.toHaveBeenCalled()
    expect(view.clientHeight).not.toHaveBeenCalled()
    expect(view.loadNewer).not.toHaveBeenCalled()
    expect(view.loadOlder).not.toHaveBeenCalled()
  })

  it('does not measure a bottom check without a newer-page loader', async () => {
    const view = await setup({ hasNewer: true, loadNewerPresent: false })
    expect(view.scrollHeight).not.toHaveBeenCalled()
    expect(view.clientHeight).not.toHaveBeenCalled()
  })

  it('does not measure while a page is already loading', async () => {
    const view = await setup({ hasNewer: true, loading: true })
    expect(view.scrollHeight).not.toHaveBeenCalled()
    expect(view.clientHeight).not.toHaveBeenCalled()
  })

  it('requests a newer page when it becomes available under a reader already at the bottom', async () => {
    const view = await setup({ scrollTop: 10_727 })
    expect(view.scrollHeight).not.toHaveBeenCalled()
    view.window.hasNewer = true
    await view.render()
    expect(view.loadNewer).toHaveBeenCalledOnce()
    expect(view.scrollHeight).toHaveBeenCalled()
  })

  it('does not measure a scroll when both ends are exhausted', async () => {
    const view = await setup({ firstSeq: 1, atBottom: false })
    await act(async () => { view.scroller.dispatchEvent(new Event('scroll')) })
    expect(view.scrollHeight).not.toHaveBeenCalled()
    expect(view.clientHeight).not.toHaveBeenCalled()
    expect(view.loadOlder).not.toHaveBeenCalled()
    expect(view.loadNewer).not.toHaveBeenCalled()
  })

  it('does not paginate a local mounted head; the same scroll resumes pagination after the real head mounts', async () => {
    const view = await setup({ atBottom: false, scrollTop: 0 })
    setMountedRange(view.scroller, 81, 120)
    await act(async () => { view.scroller.dispatchEvent(new Event('scroll')); await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve))) })
    expect(view.loadOlder).not.toHaveBeenCalled()
    expect(view.scrollHeight).not.toHaveBeenCalled()
    setMountedRange(view.scroller)
    await act(async () => { view.scroller.dispatchEvent(new Event('scroll')); await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve))) })
    expect(view.loadOlder).toHaveBeenCalledOnce()
  })

  it('does not fetch newer pages from a middle slice physical bottom', async () => {
    const view = await setup({ atBottom: false, hasNewer: true, scrollTop: 10727 })
    setMountedRange(view.scroller, 21, 40)
    await act(async () => { view.scroller.dispatchEvent(new Event('scroll')); await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve))) })
    expect(view.loadNewer).not.toHaveBeenCalled()
    expect(view.scrollHeight).not.toHaveBeenCalled()
    setMountedRange(view.scroller, 21, 120)
    await act(async () => { view.scroller.dispatchEvent(new Event('scroll')); await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve))) })
    expect(view.loadNewer).toHaveBeenCalledOnce()
  })

  it('still requests an older page at the physical top even when no newer page exists', async () => {
    const view = await setup({ atBottom: false, scrollTop: 0 })
    await act(async () => { view.scroller.dispatchEvent(new Event('scroll')); await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))) }) // read after paint (lib/afterPaint)
    expect(view.loadOlder).toHaveBeenCalledOnce()
    expect(view.loadNewer).not.toHaveBeenCalled()
    expect(view.scrollHeight).toHaveBeenCalled()
  })
})

describe('a window at the tail stays small', () => {
  const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, index) => message({ id: `m${from + index}`, seq: from + index, chat_id: 'chat-1' }))
  const older = async (_chat: string, _way: string, cursor: number, limit: number) => rows(Math.max(1, cursor - limit), cursor - 1)
  async function readHistory() {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(161, 200))
    window.setFollowingTail(false)
    await window.load('older', older as never)
    expect(window.getSnapshot()).toMatchObject({ hasNewer: false, loading: null })
    expect(window.getSnapshot().messages).toHaveLength(100)
    return window
  }

  it('does not grow while following: new rows slide an open window', () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(161, 200))
    window.update((previous) => [...previous, ...rows(201, 225)])
    expect(window.getSnapshot().messages).toHaveLength(MESSAGE_WINDOW)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('m225')
    expect(window.getSnapshot().hasOlder).toBe(true)
  })

  it('fills a short window up to its size before sliding', () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(171, 200))
    window.update((previous) => [...previous, ...rows(201, 205)])
    expect(window.getSnapshot().messages).toHaveLength(35)
    expect(window.getSnapshot().messages[0]!.id).toBe('m171')
  })

  it('a reader returning to the tail keeps the rows it paged in, then gives one back per update', async () => {
    const window = await readHistory()
    const head = window.getSnapshot().messages[0]!.id
    expect(window.setFollowingTail(true)).toBe(true)
    expect(window.getSnapshot().messages).toHaveLength(100)
    expect(window.getSnapshot().messages[0]!.id).toBe(head)
    window.update((previous) => [...previous, ...rows(201, 201)])
    expect(window.getSnapshot().messages).toHaveLength(99)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('m201')
    window.update((previous) => [...previous, ...rows(202, 270)])
    expect(window.getSnapshot().messages, 'a burst is one update: it slides, it does not drop the reader back to 40').toHaveLength(98)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('m270')
  })

  it('reading history is not interrupted: new tail rows leave the reader\'s rows in place', async () => {
    const window = await readHistory()
    const head = window.getSnapshot().messages[0]!.id
    window.update((previous) => [...previous, ...rows(201, 205)])
    expect(window.getSnapshot().messages[0]!.id).toBe(head)
    expect(window.getSnapshot().messages).toHaveLength(105)
    expect(window.getSnapshot().newMessageCount).toBe(5)
  })

  it('a page loaded while still at the bottom is not taken straight back', async () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(161, 200))
    const loading = window.load('older', older as never)
    window.setFollowingTail(false) // the list reports not following while a load is in flight
    await loading
    expect(window.setFollowingTail(true)).toBe(true)
    expect(window.getSnapshot().messages).toHaveLength(100)
    window.update((previous) => [...previous, ...rows(201, 201)])
    expect(window.getSnapshot().messages).toHaveLength(99)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('m201')
  })

  it('a window navigation moved to the tail is kept and slides like any other', async () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(261, 300))
    await window.restoreAnchor(async () => ({ messages: rows(221, 260), hasNewer: true }))
    window.setFollowingTail(false)
    await window.load('newer', (async () => rows(261, 300)) as never)
    expect(window.getSnapshot()).toMatchObject({ hasNewer: false, loading: null })
    expect(window.getSnapshot().messages).toHaveLength(80)
    expect(window.setFollowingTail(true)).toBe(true)
    expect(window.getSnapshot().messages).toHaveLength(80)
    window.update((previous) => [...previous, ...rows(301, 301)])
    expect(window.getSnapshot().messages).toHaveLength(79)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('m301')
  })

  it('a pending row survives the bound and a returning reader keeps it', async () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(161, 200))
    window.update((previous) => [...previous, message({ id: 'mine', seq: -1, is_mine: true, chat_id: 'chat-1' })])
    window.setFollowingTail(false)
    await window.load('older', older as never)
    expect(window.getSnapshot().messages.length).toBeGreaterThan(MESSAGE_WINDOW)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('mine')
    const widened = window.getSnapshot().messages.length
    window.setFollowingTail(true)
    expect(window.getSnapshot().messages).toHaveLength(widened)
    expect(window.getSnapshot().messages.at(-1)!.id).toBe('mine')
  })

  it('still opens a chat at the initial window size (control)', () => {
    const window = new ChatHistoryWindow('user-1')
    window.reset('chat-1', rows(101, 200))
    expect(window.getSnapshot().messages).toHaveLength(40)
  })
})


describe('shared conversation tail pinning', () => {
  async function setup() {
    let resized = () => {}
    vi.stubGlobal('ResizeObserver', class {
      constructor(callback: () => void) { resized = callback }
      observe() {}
      disconnect() {}
    })
    const scroller = document.createElement('div')
    let height = 600
    Object.defineProperties(scroller, {
      scrollHeight: { get: () => 12_000 }, clientHeight: { get: () => height },
    })
    const isAtBottomRef = { current: true }
    const autoscrollToBottom = vi.fn(() => { scroller.scrollTop = scroller.scrollHeight })
    const input = { resetKey: 'chat#1', messages: Array.from({ length: 120 }, (_, i) => ({ id: `m${i}`, is_mine: false })),
      enabled: true, messageWindow: { hasNewer: false, loading: null, navigation: 'reset', navigationVersion: 0 } as Pick<HistoryWindow, 'hasNewer' | 'loading' | 'navigation' | 'navigationVersion'> }
    const callbacks = { isPreservingPosition: () => false, prepareForSavedPosition: vi.fn(() => false),
      forgetSavedPosition: vi.fn(), returnToLatest: vi.fn(async () => {}), onError: vi.fn() }
    const listRef: { current: FlowListHandle | null } = { current: { autoscrollToBottom, scrollToIndex: vi.fn() } }
    const refs = { scrollerRef: { current: scroller }, listRef, isAtBottomRef }
    let actions: ReturnType<typeof useTailPinning>
    function Probe() { actions = useTailPinning({ ...input, ...callbacks, ...refs, scrollerEl: scroller }); return null }
    const render = () => harness.render(createNode(Probe))
    await render()
    autoscrollToBottom.mockClear()
    return { input, callbacks, scroller, listRef, isAtBottomRef, autoscrollToBottom, render,
      resize: (next: number) => { height = next; resized() }, pin: () => actions.pinToBottom() }
  }
  afterEach(() => vi.unstubAllGlobals())

  it('lets a mounted list place the viewport once for an explicit pin', async () => {
    const view = await setup()
    const write = vi.spyOn(view.scroller, 'scrollTop', 'set')
    view.pin()
    expect(view.autoscrollToBottom).toHaveBeenCalledOnce()
    expect(write).toHaveBeenCalledOnce()
    expect(view.scroller.scrollTop).toBe(12_000)
    write.mockRestore()
  })

  it('keeps the guarded viewport pin until its list handle is ready', async () => {
    const view = await setup()
    view.listRef.current = null
    view.scroller.scrollTop = 500
    view.pin()
    expect(view.scroller.scrollTop).toBe(12_000)
    expect(view.autoscrollToBottom).not.toHaveBeenCalled()

    view.callbacks.isPreservingPosition = () => true
    await view.render()
    view.scroller.scrollTop = 500
    view.resize(400)
    view.pin()
    expect(view.scroller.scrollTop).toBe(500)
  })

  it('pins every received tail row while a full window slides without changing height', async () => {
    const view = await setup()
    for (let seq = 120; seq < 180; seq++) {
      view.scroller.scrollTop = 11_200
      view.input.messages = [...view.input.messages.slice(1), { id: `m${seq}`, is_mine: false }]
      await view.render()
      expect(view.scroller.scrollTop).toBe(12_000)
    }
    expect(view.autoscrollToBottom).toHaveBeenCalledTimes(60)
  })

  it('does not pin a received row while the reader is above the tail', async () => {
    const view = await setup()
    view.isAtBottomRef.current = false
    view.scroller.scrollTop = 500
    view.input.messages = [...view.input.messages.slice(1), { id: 'received', is_mine: false }]
    await view.render()
    expect(view.scroller.scrollTop).toBe(500)
    expect(view.autoscrollToBottom).not.toHaveBeenCalled()
  })

  it.each(['cached-own-row', 'own-row-from-another-device'])('keeps the historical anchor when %s arrives without a local send intent', async (id) => {
    const view = await setup()
    view.isAtBottomRef.current = false
    view.scroller.scrollTop = 500
    view.callbacks.forgetSavedPosition.mockClear()
    view.input.messageWindow = { ...view.input.messageWindow, hasNewer: true }
    view.input.messages = [...view.input.messages, { id, is_mine: true }]
    await view.render()
    expect(view.scroller.scrollTop).toBe(500)
    expect(view.autoscrollToBottom).not.toHaveBeenCalled()
    expect(view.callbacks.forgetSavedPosition).not.toHaveBeenCalled()
    expect(view.callbacks.returnToLatest).not.toHaveBeenCalled()
  })

  it('pins a local optimistic send through explicit latest navigation while reading history', async () => {
    const view = await setup()
    view.isAtBottomRef.current = false
    view.scroller.scrollTop = 500
    view.input.messageWindow = { ...view.input.messageWindow, navigation: 'latest', navigationVersion: 1 }
    view.input.messages = [...view.input.messages, { id: 'local-optimistic', is_mine: true }]
    await view.render()
    expect(view.scroller.scrollTop).toBe(12_000)
    expect(view.autoscrollToBottom).toHaveBeenCalledOnce()
  })

  it.each(['older', 'newer', 'anchor'] as const)('leaves %s navigation in control of its landing', async (navigation) => {
    const view = await setup()
    view.input.messageWindow = { ...view.input.messageWindow, navigation, navigationVersion: 1 }
    view.input.messages = [{ id: 'anchor', is_mine: false }]
    await view.render()
    expect(view.autoscrollToBottom).not.toHaveBeenCalled()
  })

  it('retains the main window resize rule and returns to latest through the history controller', async () => {
    const view = await setup()
    view.resize(400)
    expect(view.autoscrollToBottom).toHaveBeenCalledOnce()
    view.isAtBottomRef.current = false
    view.resize(300)
    expect(view.autoscrollToBottom).toHaveBeenCalledOnce()
    view.input.messageWindow = { ...view.input.messageWindow, hasNewer: true }
    await view.render()
    view.pin()
    expect(view.callbacks.returnToLatest).toHaveBeenCalledOnce()
  })
})
