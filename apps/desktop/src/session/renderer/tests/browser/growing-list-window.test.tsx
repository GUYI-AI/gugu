/**
 * @@@growing-list — a list whose length grows with the user's data first mounts the lines around its visible part,
 * whatever its length (the @ candidates of a 400-member group, a member page with sections in one scroller), then grows
 * while the page is idle, up to GROW_CAP lines. Counted in Chromium, where the lines have real heights.
 */
import { ComboboxPopup, type ComboboxPopupHandle, type ComboboxPopupItem } from '@gugu/session-ui/react/primitives'
import { GROW_CAP, GrowingList, growSpan } from '@gugu/session-ui/react/growing-list'
import { act, createRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { rendererLogger } from '@/lib/log'
import { until } from '../../../../../../../tests/support/awaitCondition'
import '@renderer/index.css'

const diagnosticLog = rendererLogger('growing-readout')
let lastLoggedCount = -1
const idleFacts = { callbacks: 0, timedOut: 0, pendingInput: 0, minRemaining: Infinity }
let restoreIdle = () => {}
beforeEach(() => {
  lastLoggedCount = -1
  Object.assign(idleFacts, { callbacks: 0, timedOut: 0, pendingInput: 0, minRemaining: Infinity })
  const original = globalThis.requestIdleCallback
  if (typeof original !== 'function') return
  globalThis.requestIdleCallback = (callback, options) => original.call(globalThis, deadline => {
    idleFacts.callbacks++
    if (deadline.didTimeout) idleFacts.timedOut++
    if ((navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }).scheduling?.isInputPending?.()) idleFacts.pendingInput++
    idleFacts.minRemaining = Math.min(idleFacts.minRemaining, deadline.timeRemaining())
    callback(deadline)
  }, options)
  restoreIdle = () => { globalThis.requestIdleCallback = original }
})
function growthFacts(scroller: HTMLElement, mounted: () => number) {
  const count = mounted()
  if (count !== lastLoggedCount) {
    lastLoggedCount = count
    diagnosticLog.info({ readout: JSON.stringify({ count, monotonicMs: performance.now(),
      idleCallbacks: idleFacts.callbacks, idleMinRemaining: Number.isFinite(idleFacts.minRemaining) ? idleFacts.minRemaining : null,
      timeoutCallbacks: idleFacts.timedOut, visible: document.visibilityState === 'visible', focused: document.hasFocus() }) }, 'mount count changed')
  }
  return { mounted: mounted(), idle: { ...idleFacts }, visibility: document.visibilityState,
    focus: document.hasFocus(), top: scroller.scrollTop, height: scroller.clientHeight, scrollHeight: scroller.scrollHeight }
}

let root: Root | null = null
let container: HTMLDivElement | null = null
function mountHost(): Root {
  container = document.createElement('div')
  container.className = 'emlight gugu-skin bg-background'
  document.body.appendChild(container)
  root = createRoot(container)
  return root
}
afterEach(() => {
  act(() => root?.unmount())
  container?.remove()
  root = null
  container = null
  restoreIdle()
})

const candidates = (count: number): ComboboxPopupItem[] => Array.from({ length: count }, (_, i) => ({ id: `m${i}`, label: `Member ${i}` }))
const highlighted = () => document.querySelector<HTMLElement>('[role="option"][aria-selected="true"]')

it('400 @ candidates mount the window around the view, and the keyboard keeps the highlighted one in it', async () => {
  const ref = createRef<ComboboxPopupHandle>()
  const r = mountHost()
  act(() => r.render(<ComboboxPopup ref={ref} items={candidates(400)} anchorRect={new DOMRect(100, 100, 10, 20)} onSelect={() => {}} />))
  // The first frame, before any idle time: the lines around the view only.
  expect(highlighted()?.textContent).toContain('Member 0')
  expect(document.querySelectorAll('[role="option"]').length).toBeLessThan(40)

  for (let i = 0; i < 120; i++) act(() => void ref.current?.onKeyDown(new KeyboardEvent('keydown', { key: 'ArrowDown' })))
  await until('Member 120 is highlighted', () => highlighted()?.textContent?.includes('Member 120') === true)
  const scroller = document.querySelector<HTMLElement>('[role="listbox"] [data-growing-list]')!
  await until('it is inside the popup\'s view', () => {
    const box = highlighted()!.getBoundingClientRect(), view = scroller.getBoundingClientRect()
    return box.top >= view.top - 1 && box.bottom <= view.bottom + 1
  })
})

it('sections sharing one scroller each mount only their part in view, and scrolling brings the next one in', async () => {
  function Panel() {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
    return (
      <div ref={setScroller} data-testid="scroller" style={{ height: 400, overflowY: 'auto' }}>
        {(['people', 'agents'] as const).map((section) => (
          <section key={section} data-section={section}>
            <h3 style={{ height: 30, margin: 0 }}>{section}</h3>
            <GrowingList scroller={scroller} count={400} getKey={(i) => i} estimateSize={() => 40}
              renderLine={(i) => <div data-line={`${section}-${i}`} style={{ height: 40 }}>{section} {i}</div>} />
          </section>
        ))}
      </div>
    )
  }
  act(() => mountHost().render(<Panel />))
  expect(document.querySelector('[data-line="people-0"]')).not.toBeNull()
  expect(document.querySelectorAll('[data-line^="people-"]').length).toBeLessThan(40)
  // A list below the view still mounts its first few lines (the window always starts somewhere): far fewer than 400.
  expect(document.querySelectorAll('[data-line^="agents-"]').length).toBeLessThan(20)

  const scroller = document.querySelector<HTMLElement>('[data-testid="scroller"]')!
  // The agents section starts below 400 people lines (16 030 px): scroll to it.
  act(() => { scroller.scrollTop = 30 + 400 * 40 + 30 })
  await until('agent 0 is drawn where its section starts', () => {
    const line = document.querySelector<HTMLElement>('[data-line="agents-0"]')
    return line != null && Math.abs(line.getBoundingClientRect().top - scroller.getBoundingClientRect().top) < 2
  })
})

function counted(count: number) {
  const renders = new Map<number, number>()
  function Panel() {
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
    return (
      <div ref={setScroller} data-testid="scroller" style={{ height: 400, overflowY: 'auto' }}>
        <GrowingList scroller={scroller} count={count} getKey={(i) => i} estimateSize={() => 40} renderLine={(i) => {
          renders.set(i, (renders.get(i) ?? 0) + 1)
          return <div data-line={i} style={{ height: 40 }}>line {i}</div>
        }} />
      </div>
    )
  }
  act(() => mountHost().render(<Panel />))
  return { renders, scroller: document.querySelector<HTMLElement>('[data-testid="scroller"]')!, mounted: () => document.querySelectorAll('[data-line]').length }
}

it('an idle list grows to all its lines, each rendered once, and a scroll through them renders none', async () => {
  const { renders, scroller, mounted } = counted(400)
  expect(mounted()).toBeLessThan(40)
  await until('all 400 lines are mounted', () => growthFacts(scroller, mounted), value => value.mounted === 400)
  expect(Math.max(...renders.values())).toBe(1)
  for (let step = 1; step <= 5; step++) {
    renders.clear()
    act(() => { scroller.scrollTop = step * 2000 })
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(renders.size).toBe(0)
  }
})

it(`a list longer than GROW_CAP grows to GROW_CAP lines, and grows again around where a long scroll ends`, async () => {
  const { scroller, mounted } = counted(2000)
  await until(`${GROW_CAP} lines are mounted`, () => growthFacts(scroller, mounted), value => value.mounted === GROW_CAP)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  expect(mounted()).toBe(GROW_CAP)
  act(() => { scroller.scrollTop = 1900 * 40 })
  await until('the lines around the end are mounted, the far ones dropped', () => ({
    ...growthFacts(scroller, mounted), last: document.querySelector('[data-line="1999"]') != null,
    first: document.querySelector('[data-line="0"]') != null,
  }), value => value.last && !value.first && value.mounted === GROW_CAP)
})

it('the grown span joins the view, fills a gap towards it, and stops at the ends and at the cap', () => {
  expect(growSpan(null, { start: 0, end: 17 }, 400, 8)).toEqual({ start: 0, end: 25 })
  expect(growSpan({ start: 0, end: 25 }, { start: 0, end: 17 }, 400, 8)).toEqual({ start: 0, end: 33 })
  expect(growSpan({ start: 0, end: 399 }, { start: 100, end: 117 }, 400, 8)).toBeNull()
  expect(growSpan({ start: 10, end: 50 }, { start: 30, end: 47 }, 400, 8)).toEqual({ start: 6, end: 54 })
  expect(growSpan({ start: 0, end: 50 }, { start: 100, end: 117 }, 400, 8)).toEqual({ start: 0, end: 58 })
  expect(growSpan({ start: 0, end: 95 }, { start: 100, end: 117 }, 400, 8)).toEqual({ start: 0, end: 117 })
  expect(growSpan({ start: 0, end: GROW_CAP - 1 }, { start: 1000, end: 1017 }, 2000, 8)).toEqual({ start: 996, end: 1021 })
  expect(growSpan({ start: 0, end: GROW_CAP - 1 }, { start: 0, end: 17 }, 2000, 8)).toBeNull()
})
