/** jsdom has no layout. Model a fitting dock for behavior-only unit fixtures;
 * actual overflow and footer geometry are checked separately in Chromium.
 */
export function layOutRailDock(): () => void {
  const ownHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  const height = ownHeight ?? Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!
  const rect = HTMLElement.prototype.getBoundingClientRect
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) { return this.matches('.gg-sidebar-dock') ? 600 : height.get!.call(this) },
  })
  HTMLElement.prototype.getBoundingClientRect = function () {
    return this.matches('.gg-sidebar-item') ? DOMRect.fromRect({ width: 40, height: 40 }) : rect.call(this)
  }
  return () => {
    if (ownHeight) Object.defineProperty(HTMLElement.prototype, 'clientHeight', ownHeight)
    else Reflect.deleteProperty(HTMLElement.prototype, 'clientHeight')
    HTMLElement.prototype.getBoundingClientRect = rect
  }
}
