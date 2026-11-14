import type { NativeTextSelectionAppearance } from '@/platform/nativeTextSelection'

/** Read the restored message, after the lifted menu has released it. Values remain CSS pixels. */
export function phoneTextSelectionAppearance(element: HTMLElement): NativeTextSelectionAppearance {
  const bounds = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const fontSize = Number.parseFloat(style.fontSize) || 16
  const channels = style.color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [24, 24, 24]
  const color = '#' + channels.map(value => Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, '0')).join('')
  return {
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    viewportWidth: window.innerWidth, fontSize, lineHeight: Number.parseFloat(style.lineHeight) || fontSize * 1.5, color,
  }
}
