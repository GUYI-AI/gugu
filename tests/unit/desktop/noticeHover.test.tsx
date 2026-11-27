// @vitest-environment jsdom
//
// The notice host reports hover on a toast strip (`onHoverChange`) and says when a closed toast has really left
// (`closeNotice`). Real NoticeHost + real sonner, so the strip, its timers and its exit are the product's.
// The last case is the undo window of a permanent delete (session history): the notice and the window are one clock —
// hover held past the 8 s window pauses both, and the first delete call goes out only once the notice with 撤销 is gone.
// A press on the strip ends wherever it is released: dragged off and let go elsewhere, the countdown still resumes.
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const noticeLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => noticeLog, hasRendererLogBridge: () => false }))

import { NoticeHost } from '../../../apps/desktop/src/components/NoticeHost'
import { closeNotice, dismissNotice, notify } from '../../../apps/desktop/src/lib/notices'
import { PermanentDeleteRun, type Clock } from '../../../apps/desktop/src/session/renderer/features/sessions/permanent-delete-flow'
import { undoNoticeClock } from '../../../apps/desktop/src/session/renderer/features/session-history/undo-notice-clock'
import { createReactHarness } from '../../support/testHarness'

const toastWith = (text: string) =>
  [...document.querySelectorAll<HTMLElement>('[data-sonner-toast]')].find((toast) => toast.textContent?.includes(text)) ?? null
const enter = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })) })
const leave = (el: Element) => act(() => { el.dispatchEvent(new MouseEvent('mouseout', { bubbles: true, relatedTarget: document.body })) })
const press = (el: Element, type: 'pointerdown' | 'pointerup' | 'pointercancel') => act(() => { el.dispatchEvent(new Event(type, { bubbles: true })) })

let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  // sonner captures the pointer on a toast it may swipe; jsdom has no pointer capture.
  for (const name of ['setPointerCapture', 'releasePointerCapture'] as const) {
    if (!(name in HTMLElement.prototype)) Object.defineProperty(HTMLElement.prototype, name, { configurable: true, value: () => {} })
  }
  vi.stubGlobal('matchMedia', vi.fn((query: string): MediaQueryList => ({
    matches: false, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(),
    addListener: vi.fn(), removeListener: vi.fn(), dispatchEvent: () => true,
  })))
  harness = createReactHarness()
  await harness.render(<NoticeHost />)
})
afterEach(() => {
  harness.cleanup()
  delete document.documentElement.dataset.noticeHost
  vi.unstubAllGlobals()
})

describe('notice host: hover on a toast strip and a close that waits for the exit', () => {
  it('onHoverChange follows the pointer on the strip; pressed counts as on until released, as sonner pauses its timers', async () => {
    const hover = vi.fn()
    act(() => { notify({ key: 'hover-a', title: 'hover me', duration: 60_000, onHoverChange: hover }) })
    await vi.waitFor(() => expect(toastWith('hover me')).not.toBeNull())
    const toast = toastWith('hover me')!
    enter(toast)
    expect(hover).toHaveBeenLastCalledWith(true)
    press(toast, 'pointerdown')
    leave(toast)
    expect(hover).toHaveBeenLastCalledWith(true) // still pressed: still paused
    press(toast, 'pointerup')
    expect(hover).toHaveBeenLastCalledWith(false)
    expect(hover).toHaveBeenCalledTimes(2)
    act(() => dismissNotice('hover-a'))
  })

  it('a press dragged off the strip ends where it is released or cancelled, though the strip never hears it', async () => {
    const hover = vi.fn()
    act(() => { notify({ key: 'hover-d', title: 'drag me', duration: 60_000, onHoverChange: hover }) })
    await vi.waitFor(() => expect(toastWith('drag me')).not.toBeNull())
    const toast = toastWith('drag me')!
    enter(toast)
    press(toast, 'pointerdown')
    leave(toast)
    expect(hover).toHaveBeenLastCalledWith(true) // dragged off, still pressed
    press(document.body, 'pointerup') // let go off the strip
    expect(hover).toHaveBeenLastCalledWith(false)
    press(document.body, 'pointerup') // that press is over: nothing more
    expect(hover).toHaveBeenCalledTimes(2)
    enter(toast)
    press(toast, 'pointerdown')
    leave(toast)
    press(document.body, 'pointercancel') // the system took the pointer (e.g. a gesture): the press is over too
    expect(hover).toHaveBeenLastCalledWith(false)
    expect(hover).toHaveBeenCalledTimes(4)
    act(() => dismissNotice('hover-d'))
  })

  it('a notice shown while the strip is hovered hears it at once; a dismissed one hears nothing more', async () => {
    act(() => { notify({ key: 'hover-b1', title: 'first', duration: 60_000 }) })
    await vi.waitFor(() => expect(toastWith('first')).not.toBeNull())
    enter(toastWith('first')!)
    const hover = vi.fn()
    act(() => { notify({ key: 'hover-b2', title: 'second', duration: 60_000, onHoverChange: hover }) })
    expect(hover).toHaveBeenCalledWith(true)
    act(() => dismissNotice('hover-b2'))
    leave(document.querySelector('[data-sonner-toast]')!)
    expect(hover).toHaveBeenCalledTimes(1)
    act(() => dismissNotice('hover-b1'))
  })

  it('closeNotice resolves only once the toast is out of the DOM (not when sonner merely starts fading it)', async () => {
    act(() => { notify({ key: 'close-c', title: 'closing', duration: 60_000, action: { label: 'Undo', onClick: () => {} } }) })
    await vi.waitFor(() => expect(toastWith('closing')).not.toBeNull())
    let closed = false
    const done = closeNotice('close-c').then(() => { closed = true })
    await vi.waitFor(() => expect(toastWith('closing')?.getAttribute('data-removed')).toBe('true'))
    expect(closed).toBe(false) // fading but still on screen (and clickable)
    await act(async () => { await done })
    expect(toastWith('closing')).toBeNull()
    await expect(closeNotice('close-c')).resolves.toBeUndefined() // already gone: at once
  })
})

/** A clock the test moves by hand (the delete engine's undo window), while sonner keeps real time for its exit. */
function manualClock(): Clock & { advance: (ms: number) => void } {
  let now = 0
  let timers: { at: number; callback: () => void; handle: number }[] = []
  let seq = 0
  return {
    now: () => now,
    setTimeout: (callback, ms) => { const handle = ++seq; timers.push({ at: now + ms, callback, handle }); return handle },
    clearTimeout: (handle) => { timers = timers.filter((timer) => timer.handle !== handle) },
    advance(ms) {
      now += ms
      const due = timers.filter((timer) => timer.at <= now)
      timers = timers.filter((timer) => timer.at > now)
      for (const timer of due) timer.callback()
    },
  }
}

describe('permanent delete undo window and its notice: one clock (session history)', () => {
  it('hover held past 8 s keeps both waiting; after release the window runs out and the notice is gone before the first delete call', async () => {
    const KEY = 'session-history-permanent-delete-test'
    const clock = manualClock()
    let atFirstCall: { undoOnScreen: boolean } | null = null
    const deleteOn = vi.fn(async (_machine: string | null, targets: Array<{ projectId: string; sessionId: string }>) => {
      atFirstCall ??= { undoOnScreen: toastWith('撤销') !== null }
      return { deleted: targets, failed: [], unreached: [] }
    })
    const targets = ['a', 'b', 'c'].map((id) => ({ key: `gugu:${id}`, machine: null, projectId: 'p1', sessionId: id }))
    const binding = undoNoticeClock(KEY, () => run)
    const run: PermanentDeleteRun = new PermanentDeleteRun({ targets, withChildren: false, deleteOn, clock, beforeDelete: binding.beforeDelete })
    run.start()
    act(() => {
      notify({ key: KEY, title: '3 条会话 8 秒后开始删除', duration: 10 * 60 * 1000, ...binding.notice, action: { label: '撤销', onClick: () => run.undo() } })
    })
    await vi.waitFor(() => expect(toastWith('撤销')).not.toBeNull())

    enter(toastWith('撤销')!)
    expect(run.snapshot().undoPaused).toBe(true)
    clock.advance(9000) // held past the 8 s window
    expect(run.snapshot().phase).toBe('undo')
    expect(deleteOn).not.toHaveBeenCalled()
    expect(toastWith('撤销')).not.toBeNull()

    leave(toastWith('撤销')!)
    expect(run.snapshot().undoPaused).toBe(false)
    clock.advance(7999)
    expect(run.snapshot().phase).toBe('undo')
    act(() => clock.advance(1)) // the window is over: undo no longer counts, the notice is on its way out
    expect(run.undo()).toBe(false)
    expect(deleteOn).not.toHaveBeenCalled()

    await vi.waitFor(() => expect(deleteOn).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(atFirstCall).toEqual({ undoOnScreen: false })
    await act(async () => { await run.finished })
    expect(run.snapshot()).toMatchObject({ phase: 'done', deletedCount: 3 })
  })

  it('pressed on the notice, dragged off and released elsewhere: the window resumes and the notice leaves on time', async () => {
    const KEY = 'session-history-permanent-delete-drag-test'
    const clock = manualClock()
    let atFirstCall: { undoOnScreen: boolean } | null = null
    const deleteOn = vi.fn(async (_machine: string | null, targets: Array<{ projectId: string; sessionId: string }>) => {
      atFirstCall ??= { undoOnScreen: toastWith('撤销') !== null }
      return { deleted: targets, failed: [], unreached: [] }
    })
    const targets = ['a', 'b', 'c'].map((id) => ({ key: `gugu:${id}`, machine: null, projectId: 'p1', sessionId: id }))
    const binding = undoNoticeClock(KEY, () => run)
    const run: PermanentDeleteRun = new PermanentDeleteRun({ targets, withChildren: false, deleteOn, clock, beforeDelete: binding.beforeDelete })
    run.start()
    act(() => {
      notify({ key: KEY, title: '3 条会话 8 秒后开始删除', duration: 10 * 60 * 1000, ...binding.notice, action: { label: '撤销', onClick: () => run.undo() } })
    })
    await vi.waitFor(() => expect(toastWith('撤销')).not.toBeNull())

    const toast = toastWith('撤销')!
    enter(toast)
    press(toast, 'pointerdown')
    leave(toast) // dragged off while still pressed
    clock.advance(9000)
    expect(run.snapshot()).toMatchObject({ phase: 'undo', undoPaused: true })
    expect(deleteOn).not.toHaveBeenCalled()

    press(document.body, 'pointerup') // released off the notice: the strip never hears it
    expect(run.snapshot().undoPaused).toBe(false)
    clock.advance(7999)
    expect(run.snapshot().phase).toBe('undo')
    act(() => clock.advance(1)) // a full window after the release
    expect(run.undo()).toBe(false)

    await vi.waitFor(() => expect(deleteOn).toHaveBeenCalledTimes(1), { timeout: 3000 })
    expect(atFirstCall).toEqual({ undoOnScreen: false })
    expect(toastWith('撤销')).toBeNull()
    await act(async () => { await run.finished })
    expect(run.snapshot()).toMatchObject({ phase: 'done', deletedCount: 3 })
  })
})
