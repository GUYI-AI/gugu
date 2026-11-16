// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useToolbarDisclosure } from '../../../../packages/session-ui/src/react/components/chat-composer/use-toolbar-disclosure'

const harness = createReactHarness()
// A wider toolbar refits once its width has stopped changing (two frames without an entry).
const settled = () => act(async () => { await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => requestAnimationFrame(resolve)))) })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })
it('keeps the first resize notification from restarting an already fitted toolbar, but refits after a real width change', async () => {
  let width = 100
  let reads = 0
  const observers: Array<{ callback: (entries: ResizeObserverEntry[]) => void; targets: Element[] }> = []
  class Observer {
    targets: Element[] = []
    constructor(public callback: (entries: ResizeObserverEntry[]) => void) { observers.push(this) }
    observe(target: Element) { this.targets.push(target) }
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', Observer)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.level !== undefined ? width : 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    reads++
    const level = Number((this.closest('[data-level]') as HTMLElement)?.dataset.level ?? 0)
    const left = this.dataset.end !== undefined ? width - 20 : 0
    const w = this.dataset.level !== undefined ? width : this.dataset.end !== undefined ? 20 : level < 2 ? 200 : 80
    return { left, right: left + w, width: w, top: 0, bottom: 20, height: 20 } as DOMRect
  })
  function Toolbar() {
    const { level, ref } = useToolbarDisclosure()
    return <div ref={ref} data-level={level}><span>Variable label</span><span data-end="">Send</span></div>
  }
  await harness.render(<Toolbar />)
  const toolbar = harness.container.firstElementChild!
  expect(toolbar.getAttribute('data-level')).toBe('2')
  const initialReads = reads
  expect(initialReads).toBeGreaterThan(0)
  const observer = observers.find(item => item.targets.includes(toolbar))!
  const deliver = () => act(async () => observer.callback([{ target: toolbar, contentRect: { width } } as ResizeObserverEntry]))
  await deliver()
  expect(reads, 'initial notification must not repeat the complete shrink sequence').toBe(initialReads)
  expect(toolbar.getAttribute('data-level')).toBe('2')
  width = 300
  await deliver()
  await settled()
  expect(toolbar.getAttribute('data-level')).toBe('0')

  // A parent can resize after commit but before the very first observer notification.
  await harness.render(null)
  width = 100
  await harness.render(<Toolbar />)
  const remounted = harness.container.firstElementChild!
  expect(remounted.getAttribute('data-level')).toBe('2')
  width = 300
  const firstDelivery = observers.find(item => item.targets.includes(remounted))!
  await act(async () => firstDelivery.callback([{ target: remounted, contentRect: { width } } as ResizeObserverEntry]))
  await settled()
  expect(remounted.getAttribute('data-level')).toBe('0')
})

// A sidebar fold or a pane drag changes the toolbar width every frame. Each change used to restart the ladder at 0 and climb
// it one layout effect at a time, reading every child's rect at each step: several forced layouts per frame.
it('reads the row once per narrower frame and not at all while it widens, then refits once settled', async () => {
  const local = createReactHarness()
  onTestFinished(() => local.cleanup())
  let width = 300
  let reads = 0
  const observers: Array<{ callback: (entries: ResizeObserverEntry[]) => void; targets: Element[] }> = []
  class Observer {
    targets: Element[] = []
    constructor(public callback: (entries: ResizeObserverEntry[]) => void) { observers.push(this) }
    observe(target: Element) { this.targets.push(target) }
    disconnect() {}
  }
  vi.stubGlobal('ResizeObserver', Observer)
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (this: HTMLElement) { return this.dataset.level !== undefined ? width : 0 })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    reads++
    const level = Number((this.closest('[data-level]') as HTMLElement)?.dataset.level ?? 0)
    const left = this.dataset.end !== undefined ? width - 20 : 0
    const w = this.dataset.level !== undefined ? width : this.dataset.end !== undefined ? 20 : 200 - level * 20
    return { left, right: left + w, width: w, top: 0, bottom: 20, height: 20 } as DOMRect
  })
  function Toolbar() {
    const { level, ref } = useToolbarDisclosure()
    return <div ref={ref} data-level={level}><span>Variable label</span><span data-end="">Send</span></div>
  }
  await local.render(<Toolbar />)
  const toolbar = local.container.firstElementChild!
  expect(toolbar.getAttribute('data-level')).toBe('0')
  const observer = observers.find(item => item.targets.includes(toolbar))!
  const frameAt = async (next: number) => {
    width = next
    await act(async () => observer.callback([{ target: toolbar, contentRect: { width } } as ResizeObserverEntry]))
  }
  const rowReads = 4 // the row, its two children, the label's (empty) children: one isOverflowing
  reads = 0
  for (const next of [260, 220, 180, 160, 140]) await frameAt(next)
  expect(toolbar.getAttribute('data-level'), 'narrowing still folds as it goes').toBe('4')
  expect(reads, 'narrowing: one row read per frame, plus one per level climbed').toBeLessThanOrEqual((5 + 4) * rowReads)
  reads = 0
  // A fold delivers one entry per frame, with no gap of two frames between them.
  await act(async () => {
    for (const next of [160, 180, 220, 260, 300]) {
      width = next
      observer.callback([{ target: toolbar, contentRect: { width } } as ResizeObserverEntry])
    }
  })
  expect(reads, 'widening: no row read until the width stops').toBe(0)
  await settled()
  expect(toolbar.getAttribute('data-level'), 'refit once settled').toBe('0')
})
