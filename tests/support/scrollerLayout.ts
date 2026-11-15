/**
 * jsdom has no layout: a growing list (@@@growing-list) mounts the lines that fit its scroller, and a scroller jsdom
 * measures at 0 px fits none. Give the scrollers matching `selector` a window's size, as on screen; every other element
 * keeps jsdom's own reading. Returns the undo.
 */
export function layOutScrollers(selector: string, size = { width: 1024, height: 900 }): () => void {
  const originals = (['offsetHeight', 'offsetWidth'] as const).map((key) => [key, Object.getOwnPropertyDescriptor(HTMLElement.prototype, key)!] as const)
  for (const [key, original] of originals) {
    Object.defineProperty(HTMLElement.prototype, key, {
      configurable: true,
      get(this: HTMLElement) { return this.matches(selector) ? (key === 'offsetHeight' ? size.height : size.width) : original.get!.call(this) },
    })
  }
  return () => { for (const [key, original] of originals) Object.defineProperty(HTMLElement.prototype, key, original) }
}
