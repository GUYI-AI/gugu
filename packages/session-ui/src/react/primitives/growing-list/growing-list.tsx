import { useVirtualizer, type Range, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual'
import { flushSync } from 'react-dom'
import { memo, startTransition, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState, type CSSProperties, type Key, type ReactNode, type RefObject } from 'react'

/**
 * @@@growing-list - the one way to draw a list whose length grows with the user's data (members, contacts, search
 * results, @ candidates, the sidebar's conversations, read receipts, changed files). Only the lines around the visible
 * part of the scroller are mounted: a 400-member group mounts as many rows as a 5-member one. ❌ `rows.map(...)` for
 * such a list (lint: only this file imports @tanstack/react-virtual).
 *
 * A scroller that holds growing lists carries `data-growing-list` (the one `<GrowingList>` makes does).
 *
 * The window first holds the lines in view, then grows outwards a few lines at a time while the page is idle, up to
 * `GROW_CAP` lines: a list that was open for a moment scrolls through lines already mounted, and a flick does not have to
 * mount them on the way.
 *
 * `useGrowingList` is the window itself, for a list laid out by its owner (the sidebar shares one scroller with the
 * sections above its lines); `<GrowingList>` also draws the lines.
 */
export type GrowingListOptions = {
  count: number
  getKey: (index: number) => Key
  /** First guess of a line's height; every mounted line is then measured. */
  estimateSize: (index: number) => number
  /** The scrolling element: the list's own (`<GrowingList>` makes one when this is omitted) or a shared ancestor. */
  scroller: HTMLElement | null
  /** Lines drawn stuck to the top of the scroller while their section is in view (section heads). */
  isSticky?: (index: number) => boolean
  /** Where the lines start inside a shared scroller. */
  scrollMargin?: number
  overscan?: number
  /** Space between lines. */
  gap?: number
  /** Space before the first line and after the last, inside the scroller (❌ CSS padding on the scroller: the window
   *  would not know it, and scrolling to a line would leave it that much under the edge). */
  padding?: number
  enabled?: boolean
}

export type GrowingListWindow = Virtualizer<HTMLElement, Element> & {
  /** The sticky line in effect (the head of the section at the top), or -1; read after `getVirtualItems()`. */
  stuckIndex: () => number
}

/** Lines a window holds at most once grown (every list shares it): 600 member rows are ~12 000 DOM nodes. */
export const GROW_CAP = 600
/** One idle slice aims at this many ms (render, commit, layout of the lines it adds); the next adds fewer lines when one
 *  took longer, never under 8: on a busy machine a slice costs itself, not its lines (at 2, 600 lines took 300 slices). */
const GROW_SLICE_MS = 5
/** A page that is never idle still grows: a slice runs at the latest this long after the previous one. */
const GROW_TIMEOUT_MS = 1000

type Span = { start: number; end: number }

/**
 * The next grown span: the view joined to what is already grown, then `lines` more around it (half below, half above,
 * what one side cannot take goes to the other), at most `GROW_CAP`. A view far from the grown span (a jump, a long
 * scroll) first fills the gap towards it; a view that would make the span exceed the cap starts it over at the view.
 * null when nothing is left to grow.
 */
export function growSpan(grown: Span | null, view: Span, count: number, lines: number): Span | null {
  const last = count - 1
  if (last < 0) return null
  const kept = grown && grown.start <= last ? { start: grown.start, end: Math.min(grown.end, last) } : null
  const g = kept && Math.max(kept.end, view.end) - Math.min(kept.start, view.start) + 1 <= GROW_CAP ? kept : null
  if (g && g.end < view.start - 1) return g.end + lines >= view.start - 1 ? { start: g.start, end: view.end } : { start: g.start, end: g.end + lines }
  if (g && g.start > view.end + 1) return g.start - lines <= view.end + 1 ? { start: view.start, end: g.end } : { start: g.start - lines, end: g.end }
  const joined = g ? { start: Math.min(g.start, view.start), end: Math.max(g.end, view.end) } : view
  const room = Math.max(0, Math.min(lines, GROW_CAP - (joined.end - joined.start + 1)))
  const below = Math.min(last - joined.end, Math.ceil(room / 2))
  const above = Math.min(joined.start, room - below)
  const next = { start: joined.start - above, end: Math.min(last, joined.end + below + (room - below - above)) }
  return kept && next.start === kept.start && next.end === kept.end ? null : next
}

export function useGrowingList({ count, getKey, estimateSize, scroller, isSticky, scrollMargin = 0, overscan = 8, gap, padding = 0, enabled = true }: GrowingListOptions): GrowingListWindow {
  const stuck = useRef(-1)
  const [, redraw] = useReducer((n: number) => n + 1, 0)
  const jumping = useRef(false)
  const [grown, setGrown] = useState<Span | null>(null)
  const grownNow = useRef(grown)
  grownNow.current = grown
  const view = useRef<Span | null>(null)
  const lastIndexes = useRef<number[]>([])
  const [wakeCount, wake] = useReducer((n: number) => n + 1, 0)
  const lineWindow = useVirtualizer<HTMLElement, Element>({
    count,
    getItemKey: getKey,
    estimateSize,
    getScrollElement: () => scroller,
    // A scroll that moves the window renders it in the next task, not inside the scroll event (flushSync): the event
    // returns at once and several scroll events in one frame make one render. A jump to a line (`scrollToIndex`) still
    // renders inside: it settles over the next frames as the lines it brings in are measured, and stops early if they
    // are measured a frame late (the line it went to ends up partly outside the view).
    useFlushSync: false,
    onChange: (instance, sync) => {
      if (instance.isScrolling) { if (sync && jumping.current) flushSync(redraw); return }
      jumping.current = false
      // A scroll that ended outside the grown span (a list longer than the cap) grows again from where it is.
      const g = grownNow.current, v = view.current
      if (g && v && (v.start < g.start || v.end > g.end)) wake()
    },
    // The first frame already shows the lines that fit, before the scroller's size is observed.
    initialRect: { width: 0, height: scroller?.clientHeight || globalThis.innerHeight || 800 },
    overscan,
    gap,
    paddingStart: padding,
    paddingEnd: padding,
    scrollPaddingStart: padding,
    scrollPaddingEnd: padding,
    scrollMargin,
    enabled: enabled && scroller !== null,
    rangeExtractor: (range: Range) => {
      const indexes = new Set<number>()
      stuck.current = -1
      if (isSticky) {
        for (let i = range.startIndex; i >= 0; i--) if (isSticky(i)) { stuck.current = i; break }
        if (stuck.current >= 0) indexes.add(stuck.current)
      }
      const from = Math.max(0, range.startIndex - range.overscan), to = Math.min(range.count - 1, range.endIndex + range.overscan)
      view.current = { start: from, end: to }
      if (grown) for (let i = grown.start; i <= Math.min(grown.end, range.count - 1); i++) indexes.add(i)
      for (let i = from; i <= to; i++) indexes.add(i)
      const next = [...indexes].sort((a, b) => a - b)
      // A scroll inside the grown span keeps the same lines: the same array keeps the same items, and the lines skip.
      const same = next.length === lastIndexes.current.length && next.every((index, i) => index === lastIndexes.current[i])
      return same ? lastIndexes.current : (lastIndexes.current = next)
    },
  })

  // Idle growth: one slice per idle period (or per timeout), none while scrolling or while input waits; the slice renders
  // as a transition, so input that arrives during it still goes first. The next slice is scheduled once this one is committed.
  const sliceLines = useRef(8)
  const sliceStarted = useRef(0)
  useLayoutEffect(() => {
    if (!sliceStarted.current) return
    const spent = performance.now() - sliceStarted.current
    sliceStarted.current = 0
    sliceLines.current = Math.max(8, Math.min(64, Math.round(spent > GROW_SLICE_MS * 1.6 ? sliceLines.current / 2 : spent < GROW_SLICE_MS * 0.8 ? sliceLines.current * 1.5 : sliceLines.current)))
  }, [grown])
  const live = enabled && scroller !== null
  useEffect(() => {
    if (!live || typeof requestIdleCallback !== 'function') return
    let id = 0
    const slice = (deadline: IdleDeadline) => {
      const inputWaits = (navigator as Navigator & { scheduling?: { isInputPending?: () => boolean } }).scheduling?.isInputPending?.()
      if (lineWindow.isScrolling || inputWaits || (!deadline.didTimeout && deadline.timeRemaining() < GROW_SLICE_MS)) {
        id = requestIdleCallback(slice, { timeout: GROW_TIMEOUT_MS })
        return
      }
      const v = view.current
      const next = v && growSpan(grownNow.current, v, count, sliceLines.current)
      if (!next) return
      sliceStarted.current = performance.now()
      startTransition(() => setGrown(next))
    }
    id = requestIdleCallback(slice, { timeout: GROW_TIMEOUT_MS })
    return () => cancelIdleCallback(id)
  }, [live, grown, count, wakeCount, lineWindow])

  const jumpTo = useRef(lineWindow.scrollToIndex)
  return Object.assign(lineWindow, {
    stuckIndex: () => stuck.current,
    // Only a jump that moved the scroller (a line already in view, e.g. the hovered one, moves nothing).
    scrollToIndex: (...args: Parameters<typeof lineWindow.scrollToIndex>) => {
      const before = scroller?.scrollTop
      jumpTo.current(...args)
      if (scroller?.scrollTop !== before) jumping.current = true
    },
  })
}

/**
 * Where `lines` starts inside a shared `scroller`. Everything above it in the scroller (other sections, a lead row)
 * re-renders on its own: measured again whenever the scroller or one of its children changes size.
 */
export function useOffsetInScroller(lines: RefObject<HTMLElement | null>, scroller: HTMLElement | null, deps: readonly unknown[] = []): number {
  const [offset, setOffset] = useState(0)
  useLayoutEffect(() => {
    const node = lines.current
    if (!node || !scroller) return
    const measure = () => {
      const next = node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
      setOffset((previous) => (Math.abs(previous - next) < 0.5 ? previous : next))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(scroller)
    for (const child of scroller.children) observer.observe(child)
    return () => observer.disconnect()
  }, [lines, scroller, ...deps])
  return offset
}

/**
 * One line's content. A scroll frame re-renders `GrowingList` (the window moved) but not its owner, so `renderLine` keeps its
 * identity and every line already mounted skips rendering: only the lines entering the window render. When the owner
 * re-renders, its new `renderLine` redraws the mounted lines, as it should.
 */
const Line = memo(function Line({ index, renderLine }: { index: number; renderLine: (index: number) => ReactNode }) {
  return renderLine(index)
})

const LINES_STYLE_BASE: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }
const OWN_SCROLLER_STYLE: CSSProperties = { overflowY: 'auto', minHeight: 0 }

/**
 * The mounted lines stack in one grid cell, each moved to its place: the cell is as wide as the widest mounted line, so a
 * list in a popover is as wide as its names. The sticky head is not moved: it sits at the top and `sticky` keeps it there.
 * Each moved line is its own compositor layer (`will-change`): a line entering during a scroll paints alone instead of
 * repainting every line already on screen.
 */
export function GrowingList({ renderLine, scroller, className, style, scrollerStyle, testId, windowRef, ...options }: Omit<GrowingListOptions, 'scroller' | 'scrollMargin'> & {
  renderLine: (index: number) => ReactNode
  /** A shared scroller; without it the list scrolls itself (`scrollerStyle`, `className`, `testId` go on that element). */
  scroller?: HTMLElement | null
  className?: string
  style?: CSSProperties
  scrollerStyle?: CSSProperties
  testId?: string
  /** Receives the window, for scrolling to a line (keyboard selection, a letter rail). */
  windowRef?: (window: GrowingListWindow) => void
}) {
  const [own, setOwn] = useState<HTMLElement | null>(null)
  const linesRef = useRef<HTMLDivElement>(null)
  // In a shared scroller several lists (sections) can follow each other: each finds where it starts.
  const offset = useOffsetInScroller(linesRef, scroller ?? null)
  const scrollMargin = scroller === undefined ? 0 : offset
  const lineWindow = useGrowingList({ ...options, scrollMargin, scroller: scroller === undefined ? own : scroller })
  windowRef?.(lineWindow)
  const items = lineWindow.getVirtualItems()
  const stuckIndex = lineWindow.stuckIndex()
  // A scroll inside the grown span gives the same items: the lines are not even compared.
  const drawn = useMemo(() => items.map((item: VirtualItem) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={lineWindow.measureElement}
          style={item.index === stuckIndex
            ? { gridArea: '1 / 1', alignSelf: 'start', position: 'sticky', top: 0, zIndex: 1 }
            : { gridArea: '1 / 1', alignSelf: 'start', transform: `translateY(${item.start - scrollMargin}px)`, willChange: 'transform' }}
        >
          <Line index={item.index} renderLine={renderLine} />
        </div>
      )), [items, stuckIndex, scrollMargin, renderLine, lineWindow.measureElement])
  const lines = (
    <div ref={linesRef} style={{ ...LINES_STYLE_BASE, gridTemplateRows: `${lineWindow.getTotalSize()}px`, ...style }}>
      {drawn}
    </div>
  )
  if (scroller !== undefined) return lines
  return <div ref={setOwn} className={className} style={{ ...OWN_SCROLLER_STYLE, ...scrollerStyle }} data-growing-list="" data-testid={testId}>{lines}</div>
}
