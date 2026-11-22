/**
 * Whether an element is drawn: it has a box all the way up (no display:none, no content-visibility:hidden ancestor), its
 * visibility is not hidden, and with `opacity` its opacity is not 0 either.
 *
 * Element.checkVisibility() does exactly this, but Android System WebView before 105 has none, and 105–120 know only the
 * older option names (checkVisibilityCSS / checkOpacity), so both spellings are passed. Without it, the same rule is read
 * from computed styles up the chain (only on those engines; checkVisibility itself avoids that walk).
 */
export function isElementVisible(element: Element, { opacity = false }: { opacity?: boolean } = {}): boolean {
  if (typeof element.checkVisibility === 'function') {
    return element.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true, checkOpacity: opacity, opacityProperty: opacity })
  }
  for (let node: Element | null = element; node; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (style.display === 'none' || (node !== element && style.contentVisibility === 'hidden')) return false
    if (opacity && style.opacity === '0') return false
  }
  return getComputedStyle(element).visibility !== 'hidden'
}

export interface ElementBox { left: number; top: number; width: number; height: number }

export function elementBox(element: Element): ElementBox {
  const { left, top, width, height } = element.getBoundingClientRect()
  return { left, top, width, height }
}

function intersect(a: ElementBox, b: ElementBox): ElementBox {
  const left = Math.max(a.left, b.left), top = Math.max(a.top, b.top)
  return { left, top, width: Math.max(0, Math.min(a.left + a.width, b.left + b.width) - left),
    height: Math.max(0, Math.min(a.top + a.height, b.top + b.height) - top) }
}

/**
 * A transcript sticks a turn's user summary to the top of its scroller: the bubble covers what is under it. A summary
 * covers once its row says it is drawn stuck (data-pin-stuck); one at rest lies behind its own message and cuts nothing.
 * Only the bubble is drawn, so a clip beside it is not cut.
 */
function belowPins(scroller: Element, clip: ElementBox): ElementBox {
  let edge = clip.top
  for (const summary of scroller.querySelectorAll('[data-pin-stuck="true"] [data-pin-summary]')) {
    const box = summary.getBoundingClientRect()
    if (box.right <= clip.left || box.left >= clip.left + clip.width) continue
    edge = Math.max(edge, box.bottom)
  }
  return edge > clip.top ? intersect(clip, { left: clip.left, top: edge, width: clip.width, height: clip.top + clip.height - edge }) : clip
}

/** The resident layer and widget ownership measure the same ancestor clipping. */
export function clippedElementBox(element: HTMLElement, bounds: ElementBox): { full: ElementBox; clip: ElementBox } {
  const full = elementBox(element)
  let clip = intersect(full, bounds)
  let node: Node | null = element.parentNode
  while (node && clip.width > 0 && clip.height > 0) {
    if (node instanceof Element) {
      const style = getComputedStyle(node)
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') {
        clip = intersect(clip, elementBox(node))
        // Pins only stick inside a transcript's own scroller (ChatRoot marks it data-chat-scroll); every other clipping ancestor
        // (panes, frames) holds whole conversations, and searching those for pins grew with the mounted messages.
        if (node.hasAttribute('data-chat-scroll')) clip = belowPins(node, clip)
      }
      // A conversation's composer floats over the end of its message list (ChatBottomDock): behind its cards is not seen.
      const composer = node.hasAttribute('data-chat-dock-column') ? node.querySelector(':scope > [data-chat-bottom-dock]')?.lastElementChild : null
      if (composer) clip = intersect(clip, { left: clip.left, top: clip.top, width: clip.width, height: Math.max(0, composer.getBoundingClientRect().top - clip.top) })
      if (node.hasAttribute('data-tab-fullscreen')) break
    }
    node = node instanceof ShadowRoot ? node.host : node.parentNode
  }
  return { full, clip }
}
