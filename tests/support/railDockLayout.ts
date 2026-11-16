/** jsdom has no layout. Model a fitting dock for behavior-only unit fixtures;
 * actual overflow and footer geometry are checked separately in Chromium.
 */
export function layOutRailDock(): () => void {
  const height = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')!
  const rect = HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.matches('.gg-sidebar-dock') ? 600 : height.get!.call(this) },
  })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches('.gg-sidebar-item') ? DOMRect.fromRect({ width: 40, height: 40 }) : rect.call(this)
  }
  return () => {
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', height)
    HTMLElement.prototype.getBoundingClientRect = rect
  }
}
