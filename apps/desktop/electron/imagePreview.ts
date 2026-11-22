import { nativeImage } from 'electron'

/**
 * An image's preview, drawn in main: 560 px wide at most, PNG for a PNG (it may be transparent), JPEG otherwise. Null for
 * a format Electron cannot decode (GIF, WebP, HEIC): readers then show the original.
 */
export async function nativeImagePreview(original: Blob, contentType: string): Promise<Blob | null> {
  const image = nativeImage.createFromBuffer(Buffer.from(await original.arrayBuffer()))
  if (image.isEmpty()) return null
  const small = image.getSize().width > 560 ? image.resize({ width: 560, quality: 'good' }) : image
  return contentType === 'image/png'
    ? new Blob([new Uint8Array(small.toPNG())], { type: 'image/png' })
    : new Blob([new Uint8Array(small.toJPEG(80))], { type: 'image/jpeg' })
}
