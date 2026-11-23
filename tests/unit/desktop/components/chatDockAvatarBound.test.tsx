// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatBottomDock } from '../../../../apps/desktop/src/components/chat/ChatBottomDock'
import { createReactHarness } from '../../../support/testHarness'

let harness: ReturnType<typeof createReactHarness>
let observers: { report: () => void; targets: Element[]; disconnect: () => void }[]
beforeEach(() => {
  harness = createReactHarness()
  observers = []
  vi.stubGlobal('ResizeObserver', class {
    record: typeof observers[number]
    constructor(report: () => void) { this.record = { report, targets: [], disconnect: vi.fn() }; observers.push(this.record) }
    observe(target: Element) { this.record.targets.push(target) }
    disconnect() { this.record.disconnect() }
  })
})
afterEach(async () => { await harness.cleanup(); vi.unstubAllGlobals() })
// The dock writes its heights into one rule keyed by the column, not onto the column (@@@dock-height-rule).
function dockVar(column: HTMLElement, name: string): string {
  const id = column.getAttribute('data-chat-dock-column')
  for (const sheet of document.styleSheets) for (const rule of sheet.cssRules) {
    if (id && rule instanceof CSSStyleRule && rule.selectorText.includes(`"${id}"`)) return rule.style.getPropertyValue(name)
  }
  return ''
}

describe('avatar boundary follows the visible dock cards', () => {
  it('reserves the same measured dock height for a phone viewport and an empty conversation', async () => {
    await harness.render(createElement('div', { 'data-column': '', style: { width: 390 } },
      createElement(ChatBottomDock, { reserve: true, children: createElement('div', null, 'input') })))
    const column = harness.container.querySelector<HTMLElement>('[data-column]')!
    const dock = column.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
    Object.defineProperty(dock, 'offsetHeight', { get: () => 124 })
    await act(async () => observers[0].report())
    expect(dockVar(column, '--chat-dock-h')).toBe('124px')
    expect(column.querySelector('[aria-hidden]')?.className).toContain('h-[var(--chat-dock-h,0px)]')
    expect(dock.textContent).toBe('input')
  })

  it('uses one height observation for both dock boundaries', async () => {
    await harness.render(createElement('div', { 'data-column': '' },
      createElement(ChatBottomDock, { reserve: false, children: createElement('div', null, 'input') })))
    const column = harness.container.querySelector<HTMLElement>('[data-column]')!
    const dock = column.querySelector<HTMLElement>('[data-chat-bottom-dock]')!
    Object.defineProperty(dock.lastElementChild, 'offsetTop', { get: () => 42 })
    const height = vi.fn().mockReturnValueOnce(124).mockReturnValue(200)
    Object.defineProperty(dock, 'offsetHeight', { get: height })
    await act(async () => observers[0].report())
    expect(dockVar(column, '--chat-dock-h')).toBe('124px')
    expect(dockVar(column, '--chat-dock-avatar-h')).toBe('82px')
    expect(height).toHaveBeenCalledOnce()
  })
})
