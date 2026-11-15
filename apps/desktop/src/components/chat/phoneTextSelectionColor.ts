import type { NativeRichColor } from '@/platform/nativeRichText'

/** Resolve CSS color-mix and wide-gamut colors through the browser's own sRGB canvas. */
export function createPhoneTextSelectionColorReader(document: Document) {
  let context: CanvasRenderingContext2D | null = null
  const cache = new Map<string, NativeRichColor>()
  return (value: string): NativeRichColor => {
    const cached = cache.get(value)
    if (cached) return cached
    if (/^rgba?\([\d.,\s/]+\)$/.test(value)) {
      const parts = value.match(/[\d.]+/g)!.map(Number)
      const result = { red: parts[0], green: parts[1], blue: parts[2], alpha: parts[3] ?? 1 }
      cache.set(value, result)
      return result
    }
    if (!context) {
      const canvas = document.createElement('canvas')
      canvas.width = canvas.height = 1
      context = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (!context) throw new Error('Cannot resolve native text colors')
    context.clearRect(0, 0, 1, 1)
    context.fillStyle = value
    context.fillRect(0, 0, 1, 1)
    const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data
    const result = { red, green, blue, alpha: alpha / 255 }
    cache.set(value, result)
    return result
  }
}

