export type ScaleImage = { fit: 'width' | 'edge'; max: number; type: 'image/webp' | 'image/jpeg'; quality?: number }
export type ScaledImage = { blob: Blob; width: number; height: number }

/**
 * An image scaled down in a renderer: upright, no wider (`fit: 'width'`) or no longer on its long edge (`fit: 'edge'`)
 * than `max` px, never enlarged. createImageBitmap decodes off the page's thread, so neither this page nor Electron main
 * (which sends its images here, electron/imagePreview.ts) stops while a photo decodes.
 */
export async function scaleImage(file: Blob, { fit, max, type, quality }: ScaleImage): Promise<ScaledImage> {
  const bitmap = await createImageBitmap(file)
  try {
    const canvas = document.createElement('canvas'), scale = Math.min(1, max / (fit === 'width' ? bitmap.width : Math.max(bitmap.width, bitmap.height)))
    canvas.width = Math.max(1, Math.round(bitmap.width * scale)); canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const context = canvas.getContext('2d'); if (!context) throw new Error('Image scaling is unavailable')
    // The default ('low') aliases a 7× reduction: a 12 MP photo's preview came out speckled and several times larger.
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('Image scaling is unavailable')), type, quality))
    return { blob, width: canvas.width, height: canvas.height }
  } finally { bitmap.close() }
}

/** An image's preview: 560 px wide at most. Drawn where the sender has a canvas: the phone, the web, and the desktop window for its main process too. */
export const IMAGE_PREVIEW: ScaleImage = { fit: 'width', max: 560, type: 'image/webp' }

export async function imagePreview(file: Blob): Promise<Blob> {
  return (await scaleImage(file, IMAGE_PREVIEW)).blob
}

/** Main's images, scaled here (the `images` renderer command; electron/imagePreview.ts asks). */
export const imageCommandHandlers = {
  scale: async (params: unknown) => {
    const { bytes, contentType, ...options } = params as { bytes: Uint8Array; contentType: string } & ScaleImage
    const scaled = await scaleImage(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }), options)
    return { bytes: new Uint8Array(await scaled.blob.arrayBuffer()), type: scaled.blob.type, width: scaled.width, height: scaled.height }
  },
}
