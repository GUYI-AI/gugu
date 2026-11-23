import { nativeImage } from 'electron'

/**
 * An image's preview in an Electron process, drawn by Electron's own decoder: 560 px wide at most, PNG for a PNG (it may
 * be transparent), JPEG otherwise. A format Electron cannot decode (GIF, WebP, HEIC) rejects, and the offer warns it.
 */
export async function nativeImagePreview(original: Blob, contentType: string): Promise<Blob> {
  const image = nativeImage.createFromBuffer(Buffer.from(await original.arrayBuffer()))
  if (image.isEmpty()) throw new Error(`Electron cannot decode ${contentType}`)
  const small = image.getSize().width > 560 ? image.resize({ width: 560, quality: 'good' }) : image
  return contentType === 'image/png'
    ? new Blob([new Uint8Array(small.toPNG())], { type: 'image/png' })
    : new Blob([new Uint8Array(small.toJPEG(80))], { type: 'image/jpeg' })
}
