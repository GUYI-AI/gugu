// @vitest-environment jsdom
// #6595 消息列表的滚动机制:整个窗口按文档流排,落点 / 贴底 / 头部插行都在布局之后、绘制之前改位置。
// jsdom 没有布局:这里给一个最小的几何模型 —— 视口高 300、行高各自给定,行的屏幕位置 = 累计高度 − scrollTop,
// scrollTop 按浏览器那样夹在 [0, scrollHeight − clientHeight]。ResizeObserver 换成可手动触发的替身。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef } from 'react'
import { createReactHarness } from '../../../support/testHarness'
import { useFlowList, type FlowListHandle, type ListLanding } from '../../../../apps/desktop/src/lib/flowList'
import { PREPARE_SELECT_ALL_EVENT } from '../../../../apps/desktop/shared/window-menu-commands'

const VIEW = 300
const scrollTops = new WeakMap<Element, number>()
const heightsOf = (scroller: Element) => Array.from(scroller.firstElementChild?.children ?? []).map((row) => Number((row as HTMLElement).dataset.h))
const total = (scroller: Element) => heightsOf(scroller).reduce((a, b) => a + b, 0)
const maxTop = (scroller: Element) => Math.max(0, total(scroller) - VIEW)
const descriptors = {
  scrollHeight: { configurable: true, get(this: HTMLElement) { return this.dataset.scroller !== undefined ? total(this) : 0 } },
  clientHeight: { configurable: true, get(this: HTMLElement) { return this.dataset.scroller !== undefined ? VIEW : 0 } },
  scrollTop: {
    configurable: true,
    get(this: HTMLElement) { return scrollTops.get(this) ?? 0 },
    set(this: HTMLElement, value: number) { scrollTops.set(this, Math.min(maxTop(this), Math.max(0, value))) },
  },
}
function rect(this: HTMLElement): DOMRect {
  if (this.dataset.scroller !== undefined) return { top: 0, bottom: VIEW, height: VIEW } as DOMRect
  const scroller = this.closest<HTMLElement>('[data-scroller]')
  if (this.dataset.h === undefined || !scroller) return { top: 0, bottom: 0, height: 0 } as DOMRect
  const rows = Array.from(this.parentElement!.children) as HTMLElement[]
  const offset = rows.slice(0, rows.indexOf(this)).reduce((sum, row) => sum + Number(row.dataset.h), 0)
  const top = offset - scroller.scrollTop
  return { top, bottom: top + Number(this.dataset.h), height: Number(this.dataset.h) } as DOMRect
}

const observers: Array<() => void> = []
class FakeResizeObserver {
  constructor(private readonly callback: () => void) {}
  observe() { observers.push(this.callback) }
  disconnect() { const i = observers.indexOf(this.callback); if (i >= 0) observers.splice(i, 1) }
  unobserve() {}
}
const resize = () => act(async () => { for (const callback of [...observers]) callback() })
// 等几次绘制,证明没有无条件补满整窗。
const nextFrames = () => act(async () => { for (let i = 0; i < 3; i += 1) await new Promise((resolve) => requestAnimationFrame(() => resolve(null))) })

type Row = { id: string; h: number }
const rowsOf = (n: number, h = 100, prefix = 'r') => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, h }))
let harness: ReturnType<typeof createReactHarness>
const handleRef: { current: FlowListHandle | null } = { current: null }
const events = { atBottom: [] as boolean[], startReached: 0 }
function List({ rows, landing, resetKey = 'k', followTail = true }: { rows: Row[]; landing: ListLanding | null; resetKey?: string; followTail?: boolean }) {
  const scrollerRef = useRef<HTMLDivElement | null>(null)
  const contentRef = useRef<HTMLDivElement | null>(null)
  const { start, end } = useFlowList({
    scrollerRef, contentRef, resetKey, rowIds: rows.map((row) => row.id), landing, followTail, atBottomThreshold: 80, handleRef,
    onAtBottomChange: (atBottom) => events.atBottom.push(atBottom), onStartReached: () => { events.startReached += 1 },
  })
  return createElement('div', { key: resetKey, ref: scrollerRef, 'data-scroller': '' },
    createElement('div', { ref: contentRef }, ...rows.slice(start, end).map((row, i) => createElement('div', { key: row.id, 'data-h': row.h, 'data-id': row.id, 'aria-posinset': start + i + 1 }))))
}
const scroller = () => harness.container.querySelector<HTMLElement>('[data-scroller]')!
const rendered = () => Array.from(scroller().firstElementChild!.children).map((row) => (row as HTMLElement).dataset.id)
const topOf = (id: string) => harness.container.querySelector<HTMLElement>(`[data-id="${id}"]`)!.getBoundingClientRect().top
// Scroll-driven reads land after the frame is painted (lib/afterPaint).
const scrollTo = (top: number) => act(async () => { scroller().scrollTop = top; scroller().dispatchEvent(new Event('scroll')); await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))) })

beforeEach(() => {
  Object.defineProperties(HTMLElement.prototype, descriptors)
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(rect)
  vi.stubGlobal('ResizeObserver', FakeResizeObserver)
  harness = createReactHarness()
  events.atBottom = []; events.startReached = 0
})
afterEach(() => {
  harness.cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  for (const key of Object.keys(descriptors)) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[key]
  observers.length = 0
})

describe('useFlowList 落点(第一次绘制之前放好)', () => {
  it('最新一条:只挂视口和余量,空闲绘制不补满整窗、仍在真底', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    expect(rendered()).toEqual(rowsOf(6).map((_, i) => `r${14 + i}`))
    expect(topOf('r19')).toBe(200)
    expect(events.atBottom).toEqual([true])
    await nextFrames()
    await resize()
    expect(rendered()).toHaveLength(6)
    expect(scroller().scrollTop).toBe(300)
    expect(topOf('r19')).toBe(200)
  })
  it('读到一半的那一行:首帧它的上沿就离视口顶 -offset;上方补齐后它不动', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 5, align: 'start', offset: 16 } }))
    expect(rendered()).toEqual(rowsOf(12).map(row => row.id))
    expect(topOf('r5')).toBe(-16)
    expect(events.atBottom).toEqual([false])
    await nextFrames()
    expect(rendered()).toHaveLength(12)
    expect(topOf('r5')).toBe(-16)
  })
  it('首帧那段不够填满视口(行矮)就再补一段,仍在第一次绘制之前放好', async () => {
    await harness.render(createElement(List, { rows: rowsOf(40, 20), landing: { index: 'LAST', align: 'end' } }))
    expect(rendered().length).toBeGreaterThanOrEqual(25)
    expect(topOf('r39')).toBe(280)
  })
  it('落点按挂载读一次:同一条线里调用方换了落点不再动;换一条线(resetKey)按新落点放', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 5, align: 'start' } }))
    await nextFrames()
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    expect(topOf('r5')).toBe(0)
    await harness.render(createElement(List, { rows: rowsOf(20, 100, 'b'), landing: { index: 'LAST', align: 'end' }, resetKey: 'k2' }))
    await nextFrames()
    await resize()
    expect(scroller().scrollTop).toBe(300)
  })
})

describe('useFlowList 贴底', () => {
  it('在底部时内容长高(新消息 / 最后一条撑高)就贴住;往上翻开之后不拽', async () => {
    await harness.render(createElement(List, { rows: rowsOf(10), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    await harness.render(createElement(List, { rows: rowsOf(12), landing: null }))
    await resize()
    expect(topOf('r11')).toBe(200)

    await scrollTo(400)
    expect(events.atBottom.at(-1)).toBe(false)
    await harness.render(createElement(List, { rows: rowsOf(14), landing: null }))
    await resize()
    expect(scroller().scrollTop, '读历史的人不被拽回底部').toBe(400)
  })
  it('调用方关掉跟随(还有更新的页没载、正在定位未读)时在底部也不贴', async () => {
    await harness.render(createElement(List, { rows: rowsOf(10), landing: { index: 'LAST', align: 'end' }, followTail: false }))
    await nextFrames()
    await harness.render(createElement(List, { rows: rowsOf(12), landing: null, followTail: false }))
    await resize()
    expect(scroller().scrollTop).toBe(300)
  })
})

describe('useFlowList 头部插行', () => {
  // 滚动条正好顶在 0 时浏览器的原生锚定不管;这一格就是那种情形,也覆盖不支持锚定的 WebKit。
  it('往前接一页:读者正看着的那一行留在原处(在这次提交里,不等下一帧)', async () => {
    const rows = rowsOf(10)
    await harness.render(createElement(List, { rows, landing: { index: 3, align: 'start', offset: 20 } }))
    await nextFrames()
    expect(topOf('r3')).toBe(-20)
    await harness.render(createElement(List, { rows: [...rowsOf(5, 120, 'old'), ...rows], landing: null }))
    expect(topOf('r3')).toBe(-20)

    // 阳性对照:顶在 0 时接一页,不纠正就会停在新插进来的最早一条上。
    await scrollTo(0)
    await scrollTo(0)
    const before = topOf('old0')
    await harness.render(createElement(List, { rows: [...rowsOf(3, 80, 'older'), ...rowsOf(5, 120, 'old'), ...rows], landing: null }))
    expect(topOf('old0')).toBe(before)
    expect(scroller().scrollTop).toBe(240)
  })

  it('钉的是上沿在视口里、且不是窗口第一行的那一行:原第一行在前面接进消息后变矮(丢了日期头),它下面的内容不上跳', async () => {
    const rows = [{ id: 'first', h: 133 }, ...rowsOf(9)]
    await harness.render(createElement(List, { rows, landing: { index: 0, align: 'start' } }))
    await nextFrames()
    await scrollTo(0)
    expect(topOf('r0')).toBe(133)
    await harness.render(createElement(List, { rows: [...rowsOf(4, 100, 'old'), { id: 'first', h: 100 }, ...rowsOf(9)], landing: null }))
    expect(topOf('r0')).toBe(133)
  })
})

describe('useFlowList 句柄与回调', () => {
  it('scrollToIndex 按对齐方式定位;autoscrollToBottom 贴到真底', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    const scrollToSpy = vi.fn(function (this: HTMLElement, options: ScrollToOptions) { this.scrollTop = options.top! })
    scroller().scrollTo = scrollToSpy as unknown as HTMLElement['scrollTo']
    act(() => handleRef.current!.scrollToIndex({ index: 6, align: 'center' }))
    expect(topOf('r6')).toBe(100)
    act(() => handleRef.current!.scrollToIndex({ index: 2, align: 'start' }))
    expect(topOf('r2')).toBe(0)
    act(() => handleRef.current!.autoscrollToBottom())
    expect(scroller().scrollTop).toBe(1700)
  })
  it('a scroll event reads no layout (no forced layout per frame); at-bottom / at-top land after the frame is painted', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    scroller().scrollTop = 50
    const rects = vi.mocked(HTMLElement.prototype.getBoundingClientRect)
    const height = vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get')
    const top = vi.spyOn(HTMLElement.prototype, 'scrollTop', 'get')
    rects.mockClear()
    act(() => { scroller().dispatchEvent(new Event('scroll')) })
    expect(rects.mock.calls.length + height.mock.calls.length + top.mock.calls.length, 'layout reads inside the scroll event').toBe(0)
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve))) })
    expect(events.atBottom.at(-1)).toBe(false)
    expect(events.startReached).toBe(0)
  })
  it('滚到离顶 120px 以内就报到顶(交给调用方翻页)', async () => {
    await harness.render(createElement(List, { rows: rowsOf(20), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    while (rendered()[0] !== 'r0') await scrollTo(0)
    events.startReached = 0
    await scrollTo(500)
    expect(events.startReached).toBe(0)
    await scrollTo(100)
    expect(events.startReached).toBe(1)
  })
})


describe('grow-only mounted window', () => {
  it('grows at local edges without evicting mounted rows or paginating before the real head', async () => {
    await harness.render(createElement(List, { rows: rowsOf(120), landing: { index: 'LAST', align: 'end' } }))
    await nextFrames()
    const tail = harness.container.querySelector('[data-id="r119"]')
    expect(rendered()).toHaveLength(6)
    await scrollTo(0)
    expect(rendered().length).toBeGreaterThan(6)
    expect(rendered().length).toBeLessThan(120)
    expect(events.startReached).toBe(0)
    expect(harness.container.querySelector('[data-id="r119"]')).toBe(tail)
    expect(topOf('r117')).toBe(300)
  })
  it('does not label a middle slice as the global tail and grows newer rows when reaching its bottom', async () => {
    await harness.render(createElement(List, { rows: rowsOf(120), landing: { index: 50, align: 'start' } }))
    expect(events.atBottom).toEqual([false])
    const before = rendered()
    await scrollTo(1e6)
    expect(events.atBottom.every(value => !value)).toBe(true)
    expect(rendered().length).toBeGreaterThan(before.length)
    expect(rendered()).toEqual(expect.arrayContaining(before))
    expect(rendered()).not.toContain('r119')
  })
  it('keeps the reader and the retained rows when a 120→40 head crop removes the slice start', async () => {
    await harness.render(createElement(List, { rows: rowsOf(120), landing: { index: 'LAST', align: 'end' }, followTail: false }))
    for (let i = 0; i < 6 && !rendered().includes('r78'); i += 1) await scrollTo(0)
    const kept = harness.container.querySelector('[data-id="r100"]')
    const top = topOf('r100')
    await harness.render(createElement(List, { rows: rowsOf(120).slice(80), landing: null, followTail: false }))
    await resize()
    expect(rendered()).toEqual(rowsOf(120).slice(80).map((row) => row.id))
    expect(harness.container.querySelector('[data-id="r100"]')).toBe(kept)
    expect(topOf('r100')).toBe(top)
    expect(events.startReached).toBe(0)
  })
  it('keeps the mounted tail through full-window head trimming and follows new retained rows', async () => {
    await harness.render(createElement(List, { rows: rowsOf(120), landing: { index: 'LAST', align: 'end' } }))
    const kept = harness.container.querySelector('[data-id="r114"]')
    await harness.render(createElement(List, { rows: rowsOf(124).slice(4), landing: null }))
    await resize()
    expect(rendered()).toEqual(rowsOf(10).map((_, i) => `r${114+i}`))
    expect(harness.container.querySelector('[data-id="r114"]')).toBe(kept)
    expect(topOf('r123')).toBe(200)
    expect(events.atBottom.at(-1)).toBe(true)
  })
})


it('does not inherit a near-head slice expansion when switching to a different list', async () => {
  await harness.render(createElement(List, { rows: rowsOf(120), landing: { index: 0, align: 'start' } }))
  await scrollTo(0)
  await harness.render(createElement(List, { rows: rowsOf(120, 100, 'other'), resetKey: 'other', landing: { index: 'LAST', align: 'end' } }))
  expect(rendered()).toHaveLength(6)
  expect(topOf('other119')).toBe(200)
})


it('starts the same filled slice when rows arrive after an initially empty loading render', async () => {
  await harness.render(createElement(List, { rows: [], landing: { index: 'LAST', align: 'end' } }))
  await nextFrames()
  await harness.render(createElement(List, { rows: rowsOf(120), landing: { index: 'LAST', align: 'end' } }))
  await nextFrames()
  expect(rendered()).toHaveLength(6)
  expect(topOf('r119')).toBe(200)
})

it('clamps a stale landing beyond rows arriving after an empty loading render', async () => {
  const landing: ListLanding = { index: 10, align: 'start' }
  await harness.render(createElement(List, { rows: [], landing }))
  await nextFrames()
  await harness.render(createElement(List, { rows: rowsOf(3), landing }))
  await nextFrames()
  expect(rendered()).toEqual(['r0', 'r1', 'r2'])
  expect(topOf('r2')).toBe(200)
  expect(events.atBottom.at(-1)).toBe(true)
})

it('fills the loaded window before native Select All without moving the reader or replacing mounted rows', async () => {
  await harness.render(createElement(List, { rows: rowsOf(40), landing: { index: 30, align: 'start' } }))
  const kept = harness.container.querySelector('[data-id="r30"]')
  const before = topOf('r30')
  expect(rendered().length).toBeLessThan(40)
  const event = new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })
  await act(async () => { scroller().dispatchEvent(event) })
  expect(rendered()).toEqual(rowsOf(40).map(row => row.id))
  expect(topOf('r30')).toBe(before)
  expect(harness.container.querySelector('[data-id="r30"]')).toBe(kept)
  expect(event.defaultPrevented).toBe(false)
})

it('leaves editing shortcuts and keys from another input alone, and supports Control+A in the transcript', async () => {
  await harness.render(createElement(List, { rows: rowsOf(40), landing: { index: 'LAST', align: 'end' } }))
  const inside = document.createElement('input'), outside = document.createElement('input')
  scroller().append(inside)
  harness.container.append(outside)
  await act(async () => {
    inside.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }))
    outside.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true }))
    scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true }))
  })
  expect(rendered()).toHaveLength(6)
  const before = topOf('r39')
  await act(async () => { scroller().dispatchEvent(new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })) })
  expect(rendered()).toHaveLength(40)
  expect(topOf('r39')).toBe(before)
})

it('uses the same fill for native menu preparation while leaving an editable target alone', async () => {
  await harness.render(createElement(List, { rows: rowsOf(40), landing: { index: 'LAST', align: 'end' } }))
  const editor = document.createElement('div')
  editor.setAttribute('contenteditable', 'true')
  scroller().append(editor)
  await act(async () => { editor.dispatchEvent(new Event(PREPARE_SELECT_ALL_EVENT, { bubbles: true })) })
  expect(rendered()).toHaveLength(6)
  const before = topOf('r39')
  await act(async () => { scroller().dispatchEvent(new Event(PREPARE_SELECT_ALL_EVENT, { bubbles: true })) })
  expect(rendered()).toHaveLength(40)
  expect(topOf('r39')).toBe(before)
})
