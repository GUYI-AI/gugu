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
      if (style.overflowX !== 'visible' || style.overflowY !== 'visible') clip = intersect(clip, elementBox(node))
      // A conversation's composer floats over the end of its message list (ChatBottomDock): behind its cards is not seen.
      const composer = node.hasAttribute('data-chat-dock-column') ? node.querySelector(':scope > [data-chat-bottom-dock]')?.lastElementChild : null
      if (composer) clip = intersect(clip, { left: clip.left, top: clip.top, width: clip.width, height: Math.max(0, composer.getBoundingClientRect().top - clip.top) })
      if (node.hasAttribute('data-tab-fullscreen')) break
    }
    node = node instanceof ShadowRoot ? node.host : node.parentNode
  }
  return { full, clip }
}
