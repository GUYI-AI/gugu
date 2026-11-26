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

/** The resident layer and widget ownership measure the same ancestor clipping. */
export function clippedElementBox(element: HTMLElement, bounds: ElementBox): { full: ElementBox; clip: ElementBox } {
  const full = elementBox(element)
  let clip = intersect(full, bounds)
  let node: Node | null = element.parentNode
  while (node && clip.width > 0 && clip.height > 0) {
    if (node instanceof Element) {
      const style = getComputedStyle(node)
      // Each axis clips on its own: overflow-x clip with overflow-y visible (the chat workspace's pages, two cards) cuts
      // only left and right — a page reaching above that box (the tool card's body under its strip) is still drawn there.
      const clipsX = style.overflowX !== 'visible', clipsY = style.overflowY !== 'visible'
      if (clipsX || clipsY) {
        const box = elementBox(node)
        clip = intersect(clip, {
          left: clipsX ? box.left : clip.left, width: clipsX ? box.width : clip.width,
          top: clipsY ? box.top : clip.top, height: clipsY ? box.height : clip.height,
        })
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
