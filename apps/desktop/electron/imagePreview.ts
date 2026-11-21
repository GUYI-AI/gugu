import { nativeImage } from 'electron'
import { offerImagePreview, type AttachmentsEndpoint } from '@gugu/core/cloud/attachmentsApi'

/**
 * An image's preview, drawn in main and offered for the original's bytes: 560 px wide at most, PNG for a PNG (it may be
 * transparent), JPEG otherwise. Nothing for a format Electron cannot decode (GIF, WebP, HEIC): readers then show the original.
 */
export async function offerNativeImagePreview(endpoint: AttachmentsEndpoint, original: Blob, contentType: string, sha256: string, as: string): Promise<void> {
  const image = nativeImage.createFromBuffer(Buffer.from(await original.arrayBuffer()))
  if (image.isEmpty()) return
  const small = image.getSize().width > 560 ? image.resize({ width: 560, quality: 'good' }) : image
  const preview = contentType === 'image/png'
    ? new Blob([new Uint8Array(small.toPNG())], { type: 'image/png' })
    : new Blob([new Uint8Array(small.toJPEG(80))], { type: 'image/jpeg' })
  await offerImagePreview(endpoint, preview, sha256, as)
}
