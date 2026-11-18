import type { NativeTextSelectionAppearance } from '@/platform/nativeTextSelection'
import { createPhoneTextSelectionColorReader } from './phoneTextSelectionColor'

/** Read the restored message, after the lifted menu has released it. Values remain CSS pixels. */
export function phoneTextSelectionAppearance(element: HTMLElement): NativeTextSelectionAppearance {
  const bounds = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  const fontSize = Number.parseFloat(style.fontSize) || 16
  const rgb = createPhoneTextSelectionColorReader(element.ownerDocument)(style.color)
  const color = '#' + [rgb.red, rgb.green, rgb.blue].map(value => Math.round(value).toString(16).padStart(2, '0')).join('')
  return {
    x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
    viewportWidth: window.innerWidth, fontSize, lineHeight: Number.parseFloat(style.lineHeight) || fontSize * 1.5, color,
  }
}
