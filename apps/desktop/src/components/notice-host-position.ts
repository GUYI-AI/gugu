import { useLayoutEffect, useState } from 'react'

// The phone bar's actual box includes its token height, lower gap and safe area.
const ANCHORS = '[data-slot="composer"], [data-phone-shell] [data-phone-tabbar]'
// Product spacing: the notice stack ends 8px above every visible composer or phone bar.
const COMPOSER_GAP = 8

export function readNoticeComposerBottom(): number | undefined {
  let top = window.innerHeight
  let visible = false
  for (const composer of document.querySelectorAll<HTMLElement>(ANCHORS)) {
    // Retained task/chat surfaces keep their layout while content-visibility hides them.
    if (!composer.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) continue
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
    const resize = new ResizeObserver(() => measure())
    const measure = () => {
      const next = new Set<Element>()
      for (const composer of document.querySelectorAll(ANCHORS)) {
        // A parent can move the composer without changing its own size (pane/layout changes).
        for (let element: Element | null = composer; element; element = element.parentElement) next.add(element)
      }
      for (const element of observed) if (!next.has(element)) { resize.unobserve(element); observed.delete(element) }
      for (const element of next) if (!observed.has(element)) { resize.observe(element); observed.add(element) }
      const value = readNoticeComposerBottom()
      setBottom((previous) => previous === value ? previous : value)
    }
    const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; measure() }) }
    const containsComposer = (node: Node) => node instanceof Element && (node.matches(ANCHORS) || node.querySelector(ANCHORS) !== null)
    const mutations = new MutationObserver((records) => {
      // Streaming transcript rows and Sonner's own style updates do not change the anchor.
      if (records.some((record) => record.type === 'attributes'
        ? (record.attributeName !== 'style' || showsOrHides(record)) && containsComposer(record.target)
        : [...record.addedNodes, ...record.removedNodes].some(containsComposer))) schedule()
    })
    mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeOldValue: true, attributeFilter: ['class', 'style', 'hidden', 'data-state'] })
    window.addEventListener('resize', schedule)
    document.addEventListener('scroll', schedule, true)
    measure()
    return () => {
      if (frame) cancelAnimationFrame(frame)
      resize.disconnect()
      mutations.disconnect()
      window.removeEventListener('resize', schedule)
      document.removeEventListener('scroll', schedule, true)
    }
  }, [active])
  return bottom
}
