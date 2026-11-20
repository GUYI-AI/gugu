import { rendererLogger } from '@/lib/log'

const log = rendererLogger('redraw-image')

/**
 * Settles when the image has loaded or failed. Not `image.decode()`: a hidden document (the phone's WebView with the app
 * in the background) renders no frame, decode waits for one, and its promise then never settles — while `load` and
 * `error` fire regardless and `drawImage` decodes by itself. A face drawn for a notification is drawn exactly then.
 */
function loaded(image: HTMLImageElement, src: string): Promise<void> {
  return new Promise((resolve, reject) => {
    image.onload = () => resolve()
    image.onerror = () => reject(new Error('image failed to load'))
    image.src = src
  })
}

/**
 * An image drawn again on a canvas, `size` px square, as a `data:` URL: what a page is handed instead of the source, so
 * only bytes this window wrote go on (a member's face, a phone App's icon). `cover` takes the middle square, as round
 * avatars crop it (object-fit: cover) — one with no size of its own (an SVG with only a viewBox) fills the square;
 * `fill` stretches it, as the desktop resizes an App's icon (extension-icon.ts). Null when it does not load or draw.
 */
export async function redrawImage(
  src: string,
  { size, fit, type, quality }: { size: number; fit: 'cover' | 'fill'; type: 'image/png' | 'image/webp'; quality?: number },
): Promise<string | null> {
  let phase: 'load' | 'draw' = 'load'
  try {
    const image = new Image()
    // An upload is on the storage host: drawn on a canvas only as a CORS image, or the canvas cannot be read back.
    image.crossOrigin = 'anonymous'
    await loaded(image, src)
    phase = 'draw'
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) return null
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    if (fit === 'cover' && side > 0) {
      context.drawImage(image, (image.naturalWidth - side) / 2, (image.naturalHeight - side) / 2, side, side, 0, 0, size, size)
    } else {
      context.drawImage(image, 0, 0, size, size)
    }
    return canvas.toDataURL(type, quality)
  } catch (error) {
    // Never the address: it names a person's upload.
    log.warn({ phase, error: error instanceof Error ? error.name : 'unknown' }, 'image could not be drawn')
    return null
  }
}
