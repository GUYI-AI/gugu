import { useLayoutEffect, useState } from 'react'

// The phone bar's actual box includes its token height, lower gap and safe area.
const ANCHORS = '[data-slot="composer"], [data-phone-shell] [data-phone-tabbar]'
// Product spacing: the notice stack ends 8px above every visible composer or phone bar.
const COMPOSER_GAP = 8

/** Where the strip sits: `bottom` = its gap from the viewport bottom, `center` = the x it is centred on. */
export type NoticeAnchor = { bottom: number; center: number }

/** One rule (desktop and phone): the strip is centred on the composer (or phone bar) it sits 8px above. */
export function readNoticeComposerAnchor(anchors: Iterable<Element> = document.querySelectorAll(ANCHORS)): NoticeAnchor | undefined {
  let top = window.innerHeight
  let center: number | undefined
  for (const composer of anchors) {
    // Retained task/chat surfaces keep their layout while content-visibility hides them.
    if (!composer.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
    const rect = composer.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0 || rect.right <= 0 || rect.left >= window.innerWidth || rect.bottom <= 0 || rect.top >= window.innerHeight) continue
    if (center !== undefined && rect.top >= top) continue
    top = rect.top
    center = Math.round(rect.left + rect.width / 2)
  }
  return center === undefined ? undefined : { bottom: window.innerHeight - top + COMPOSER_GAP, center }
}

// Inline style only matters here when it hides or shows a box in place (a retained surface: content-visibility,
// lib/retainedSurface.ts); no ResizeObserver entry reports that. Size, position and transform writes (a sidebar fold, every
// frame) are not compared: the observers above read them after layout.
const hidingStyle = (style: string | null) => style?.match(/(?:content-)?visibility\s*:[^;]*/g)?.join(';') ?? ''
const showsOrHides = (record: MutationRecord) => hidingStyle(record.oldValue) !== hidingStyle((record.target as Element).getAttribute('style'))

/** The single outlet follows actual composer/navigation geometry, including retained/split surfaces. */
export function useNoticeComposerAnchor(active: boolean): NoticeAnchor | undefined {
  const [anchor, setAnchor] = useState<NoticeAnchor>()
  useLayoutEffect(() => {
    if (!active) return
    let frame = 0
    const observed = new Set<Element>()
    let anchors: Element[] = []
    // @@@anchor-scan - the document is searched for anchors only when the DOM may have added, removed, shown or hidden one
    // (the mutation filter below). A resize or scroll re-reads the anchors already found: ❌ a whole-document query there. A
    // fold resizes the page every frame, and that query grew with every mounted message row (~116k nodes at 120 rows).
    const read = () => {
      const value = readNoticeComposerAnchor(anchors)
      setAnchor((previous) => previous?.bottom === value?.bottom && previous?.center === value?.center ? previous : value)
    }
    const resize = new ResizeObserver(read)
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
    const mutations = new MutationObserver((records) => {
      // Streaming transcript rows and Sonner's own style updates do not change the anchor.
      if (records.some((record) => record.type === 'attributes'
        ? (record.attributeName !== 'style' || showsOrHides(record)) && containsComposer(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(containsComposer))) schedule(true)
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'data-state'] })
    window.addEventListener('resize', reread)
    document.addEventListener('scroll', reread, true)
    scan()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', reread)
      document.removeEventListener('scroll', reread, true)
    }
  }, [active])
  return anchor
}
