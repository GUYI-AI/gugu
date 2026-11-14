import { useVirtualizer, type Range, type VirtualItem, type Virtualizer } from '@tanstack/react-virtual'
import { useLayoutEffect, useRef, useState, type CSSProperties, type Key, type ReactNode, type RefObject } from 'react'

/**
 * @@@growing-list - the one way to draw a list whose length grows with the user's data (members, contacts, search
 * results, @ candidates, the sidebar's conversations, read receipts, changed files). Only the lines around the visible
 * part of the scroller are mounted: a 400-member group mounts as many rows as a 5-member one. ❌ `rows.map(...)` for
 * such a list (lint: only this file imports @tanstack/react-virtual).
 *
 * A scroller that holds growing lists carries `data-growing-list` (the one `<GrowingList>` makes does).
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

export function useGrowingList({ count, getKey, estimateSize, scroller, isSticky, scrollMargin = 0, overscan = 8, gap, padding = 0, enabled = true }: GrowingListOptions): GrowingListWindow {
  const stuck = useRef(-1)
  const lineWindow = useVirtualizer<HTMLElement, Element>({
    count,
    getItemKey: getKey,
    estimateSize,
    getScrollElement: () => scroller,
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
      for (let i = Math.max(0, range.startIndex - range.overscan); i <= Math.min(range.count - 1, range.endIndex + range.overscan); i++) indexes.add(i)
      return [...indexes].sort((a, b) => a - b)
    },
  })
  return Object.assign(lineWindow, { stuckIndex: () => stuck.current })
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

const LINES_STYLE_BASE: CSSProperties = { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)' }
const OWN_SCROLLER_STYLE: CSSProperties = { overflowY: 'auto', minHeight: 0 }

/**
 * The mounted lines stack in one grid cell, each moved to its place: the cell is as wide as the widest mounted line, so a
 * list in a popover is as wide as its names. The sticky head is not moved: it sits at the top and `sticky` keeps it there.
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
  const lines = (
    <div ref={linesRef} style={{ ...LINES_STYLE_BASE, gridTemplateRows: `${lineWindow.getTotalSize()}px`, ...style }}>
      {items.map((item: VirtualItem) => (
        <div
          key={item.key}
          data-index={item.index}
          ref={lineWindow.measureElement}
          style={item.index === stuckIndex
            ? { gridArea: '1 / 1', alignSelf: 'start', position: 'sticky', top: 0, zIndex: 1 }
            : { gridArea: '1 / 1', alignSelf: 'start', transform: `translateY(${item.start - scrollMargin}px)` }}
        >
          {renderLine(item.index)}
        </div>
      ))}
    </div>
  )
  if (scroller !== undefined) return lines
  return <div ref={setOwn} className={className} style={{ ...OWN_SCROLLER_STYLE, ...scrollerStyle }} data-growing-list="" data-testid={testId}>{lines}</div>
}
