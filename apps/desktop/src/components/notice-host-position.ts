import { useLayoutEffect, useState } from 'react'
import { isElementVisible } from '@/lib/elementVisibility'

// The phone bar's actual box includes its token height, lower gap and safe area.
const ANCHORS = '[data-slot="composer"], [data-phone-shell] [data-phone-tabbar]'
// Product spacing: the notice stack ends 8px above every visible composer or phone bar.
const COMPOSER_GAP = 8

export function readNoticeComposerBottom(anchors: Iterable<Element> = document.querySelectorAll(ANCHORS)): number | undefined {
  let top = window.innerHeight
  let visible = false
  for (const composer of anchors) {
    // Retained task/chat surfaces keep their layout while content-visibility hides them.
    if (!isElementVisible(composer, { opacity: true })) continue
    const rect = composer.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.left >= window.innerWidth || rect.bottom <= 0 || rect.top >= window.innerHeight) continue
    visible = true
    top = Math.min(top, rect.top)
  }
  return visible ? window.innerHeight - top + COMPOSER_GAP : undefined
}

// Inline style only matters here when it hides or shows a box in place (a retained surface: content-visibility,
// lib/retainedSurface.ts); no ResizeObserver entry reports that. Size, position and transform writes (a sidebar fold, every
// frame) are not compared: the observers above read them after layout.
const hidingStyle = (style: string | null) => style?.match(/(?:content-)?visibility\s*:[^;]*/g)?.join(';') ?? ''
const showsOrHides = (record: MutationRecord) => hidingStyle(record.oldValue) !== hidingStyle((record.target as Element).getAttribute('style'))

/** The single outlet follows actual composer/navigation geometry, including retained/split surfaces. */
export function useNoticeComposerBottom(active: boolean): number | undefined {
  const [bottom, setBottom] = useState<number>()
  useLayoutEffect(() => {
    if (!active) return
    let frame = 0
    const observed = new Set<Element>()
    let anchors: Element[] = []
    // @@@anchor-scan - the document is searched for anchors only when the DOM may have added, removed, shown or hidden one
    // (the mutation filter below). A resize or scroll re-reads the anchors already found: ❌ a whole-document query there. A
    // fold resizes the page every frame, and that query grew with every mounted message row (~116k nodes at 120 rows).
    const read = () => {
      const value = readNoticeComposerBottom(anchors)
      setBottom((previous) => previous === value ? previous : value)
    }
    // Only a height can move the composer's top: a pane narrowing or widening (every frame of a panel's move) is no reason
    // to read, ❌ a forced layout per frame. A box that rewraps changes its own height, and is observed too.
    const heights = new WeakMap<Element, number>()
    const resize = new ResizeObserver((entries) => {
      let moved = false
      for (const { target, contentRect } of entries) {
        if (heights.get(target) !== contentRect.height) moved = true
        heights.set(target, contentRect.height)
      }
      if (moved) read()
    })
    const scan = () => {
      anchors = [...document.querySelectorAll(ANCHORS)]
      const next = new Set<Element>()
      // A parent can move the composer without changing its own size (pane/layout changes).
      for (const composer of anchors) for (let element: Element | null = composer; element; element = element.parentElement) next.add(element)
      for (const element of observed) if (!next.has(element)) { resize.unobserve(element); observed.delete(element) }
      for (const element of next) if (!observed.has(element)) { resize.observe(element); observed.add(element) }
      read()
    }
    let rescan = false
    const schedule = (again: boolean) => { rescan ||= again; if (!frame) frame = requestAnimationFrame(() => { frame = 0; const scanNow = rescan; rescan = false; if (scanNow) scan(); else read() }) }
    const reread = () => schedule(false)
    const containsComposer = (node: Node) => node instanceof Element && (node.matches(ANCHORS) || node.querySelector(ANCHORS) !== null)
    // A scroll moves the composer only if the box scrolled holds it (❌ the transcript beside it, which scrolls as it rewraps).
    const scrolled = (event: Event) => { if (event.target === document || (event.target instanceof Node && containsComposer(event.target))) reread() }
    const mutations = new MutationObserver((records) => {
      // Streaming transcript rows and Sonner's own style updates do not change the anchor.
      if (records.some((record) => record.type === 'attributes'
        ? (record.attributeName !== 'style' || showsOrHides(record)) && containsComposer(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(containsComposer))) schedule(true)
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'data-state'] })
    window.addEventListener('resize', reread)
    document.addEventListener('scroll', scrolled, true)
    scan()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', reread)
      document.removeEventListener('scroll', scrolled, true)
    }
  }, [active])
  return bottom
}
