// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'
import { useToolbarDisclosure } from '../../../../packages/session-ui/src/react/components/chat-composer/use-toolbar-disclosure'

const harness = createReactHarness()
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
  expect(remounted.getAttribute('data-level')).toBe('0')
})
