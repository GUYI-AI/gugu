// @vitest-environment jsdom
import { act, createElement } from 'react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GroupAvatarSlot } from '../../../../apps/desktop/src/components/chat/StickyGroupAvatar'
import { MessageRow } from '../../../../apps/desktop/src/components/chat/MessageRow'
import { createReactHarness } from '../../../support/testHarness'

const observers: { callback: ResizeObserverCallback; targets: Set<Element>; initial: Set<Element> }[] = []
let harness: ReturnType<typeof createReactHarness>
beforeAll(() => {
  vi.stubGlobal('ResizeObserver', class {
    record: typeof observers[number]
    constructor(callback: ResizeObserverCallback) { this.record = { callback, targets: new Set(), initial: new Set() }; observers.push(this.record) }
    observe(target: Element) { if (!this.record.targets.has(target)) this.record.initial.add(target); this.record.targets.add(target) }
    unobserve(target: Element) { this.record.targets.delete(target); this.record.initial.delete(target) }
    disconnect() { this.record.targets.clear(); this.record.initial.clear() }
  })
})
beforeEach(() => { harness = createReactHarness() })
afterEach(async () => { await harness.cleanup(); vi.restoreAllMocks() })
afterAll(() => { vi.unstubAllGlobals() })

/** The real row (MessageRow: track + body) holding what MessageBubble draws: the avatar slot, then the bubble. */
function row(id: string, previous = false, next = false, wide = false) {
  return createElement(MessageRow, { messageId: id, key: id, children: createElement('div', null,
    createElement(GroupAvatarSlot, { wide, groupedWithPrev: previous, groupedWithNext: next, children: createElement('button', null, id) }),
    createElement('div', { 'data-message-bubble-row': '' }, id)) })
}

/** Rows at their top; a bubble at [top, bottom] in page coordinates; the gutter 8 px in, 32 px wide. */
function geometry(rows: Record<string, { row: number; bubble: [number, number] }>, events?: string[]) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const id = this.closest('[data-msg-id]')?.getAttribute('data-msg-id') ?? ''
    events?.push(`read:${id}`)
    const box = rows[id]!
    if (this.hasAttribute('data-message-bubble-row')) return { top: box.bubble[0], bottom: box.bubble[1], left: 40, width: 200 } as DOMRect
    if (this.getAttribute('role') === 'listitem') return { top: box.row, bottom: box.bubble[1] + 4, left: 0, width: 400 } as DOMRect
    return { top: box.row, bottom: box.bubble[1], left: 8, width: 32 } as DOMRect
  })
}

const track = (id: string) => harness.container.querySelector<HTMLElement>(`[data-msg-id="${id}"] > [data-avatar-track]`)
const span = (id: string) => [track(id)!.style.marginTop, track(id)!.style.height]

async function resize(targets: Element[]) {
  await act(async () => {
    for (const observer of observers) {
      const entries = [...new Set([...targets, ...observer.initial])].filter(target => observer.targets.has(target)).map(target => ({ target }) as ResizeObserverEntry)
      observer.initial.clear()
      if (entries.length) observer.callback(entries, {} as ResizeObserver)
    }
  })
}

describe('sticky group avatar track', () => {
  it('draws the avatar on a track before the row body, in the bubble order, and only for a group tail', async () => {
    await harness.render(createElement('div', { 'data-list': '' }, row('start', false, true), row('end', true)))
    expect(track('start')).toBeNull()
    const end = harness.container.querySelector('[data-msg-id="end"]')!
    const [first, second] = [...end.children]
    expect(first.hasAttribute('data-avatar-track')).toBe(true)
    expect(second.hasAttribute('data-row-body')).toBe(true)
    // The avatar is outside the skipped body, and still before its bubble in the document (focus and reading order).
    const avatar = first.querySelector('button')!, bubble = end.querySelector('[data-message-bubble-row]')!
    expect(avatar.compareDocumentPosition(bubble) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('reads both conversation panels before writing any track, and spans each group from its first bubble to its tail', async () => {
    await harness.render(createElement('div', null,
      createElement('div', { 'data-list': 'group' }, row('single'), row('start', false, true), row('end', true)),
      createElement('div', { 'data-list': 'topic' }, row('topic', false, false, true))))
    const events: string[] = []
    geometry({ single: { row: 0, bubble: [10, 40] }, start: { row: 50, bubble: [60, 80] }, end: { row: 85, bubble: [90, 130] }, topic: { row: 0, bubble: [20, 70] } }, events)
    for (const id of ['single', 'end', 'topic']) for (const property of ['marginTop', 'height'] as const) {
      const style = track(id)!.style
      let prototype = Object.getPrototypeOf(style)
      while (!Object.hasOwn(prototype, property)) prototype = Object.getPrototypeOf(prototype)
      const descriptor = Object.getOwnPropertyDescriptor(prototype, property)!
      Object.defineProperty(style, property, { configurable: true, get: () => descriptor.get!.call(style), set(value: string) {
        events.push(`write:${property}`); descriptor.set!.call(style, value)
      } })
    }
    await resize([...harness.container.querySelectorAll('[data-list]')])
    const firstWrite = events.findIndex(event => event.startsWith('write:'))
    expect(firstWrite).toBeGreaterThan(0)
    expect(events.slice(firstWrite).every(event => event.startsWith('write:'))).toBe(true)
    // marginTop lifts the track from its row's top to the group's first bubble; height reaches the tail's bubble bottom.
    expect(span('single')).toEqual(['10px', '30px'])
    expect(span('end')).toEqual(['-25px', '70px'])
    expect(span('topic')).toEqual(['20px', '50px'])
    expect(track('end')!.style.marginLeft).toBe('8px')
    expect(harness.container.querySelector('[data-msg-id="topic"] [data-row-body] > div > div')?.className).toContain('w-[var(--msg-avatar-gutter-touch)]')
  })

  it('keeps observing a list until its last avatar leaves and updates grouping on reused rows', async () => {
    const render = (second: boolean, grouped: boolean) => harness.render(createElement('div', { 'data-list': '' },
      row('start', false, grouped), second && row('end', grouped)))
    await render(true, true)
    const list = harness.container.querySelector('[data-list]')!
    const active = () => observers.filter(observer => observer.targets.has(list))
    expect(active()).toHaveLength(1)
    geometry({ start: { row: 0, bubble: [10, 40] }, end: { row: 45, bubble: [50, 80] } })
    await resize([list])
    expect(span('end')).toEqual(['-35px', '70px'])
    await render(true, false)
    // The list can keep its dimensions when grouping changes; a new track still gets its first delivery.
    await resize([])
    expect(span('end')).toEqual(['5px', '30px'])
    expect(span('start')).toEqual(['10px', '30px'])
    await render(false, false)
    expect(active()).toHaveLength(1)
    await harness.render(null)
    expect(active()).toHaveLength(0)
    expect(observers.every(observer => observer.targets.size === 0)).toBe(true)
  })
})

it('bounds a continued group from its first mounted row when the true group head is outside the slice', async () => {
  await harness.render(createElement('div', { 'data-list': '' }, row('middle', true, true), row('tail', true)))
  const rows = { head: { row: -60, bubble: [-50, -10] as [number, number] }, middle: { row: 0, bubble: [10, 60] as [number, number] }, tail: { row: 65, bubble: [70, 120] as [number, number] } }
  geometry(rows)
  await resize([])
  expect(span('tail')).toEqual(['-55px', '110px'])
  await harness.render(createElement('div', { 'data-list': '' }, row('head', false, true), row('middle', true, true), row('tail', true)))
  await resize([harness.container.querySelector('[data-list]')!])
  expect(span('tail')).toEqual(['-115px', '170px'])
})
