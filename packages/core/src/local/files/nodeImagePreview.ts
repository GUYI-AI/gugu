/**
 * An image's preview in a plain-Node process (the headless server, the phone's agent runtime), drawn by libvips through
 * sharp: upright (EXIF orientation applied), 560 px wide at most, PNG for a PNG (it may be transparent), JPEG otherwise.
 * libvips decodes on its own threads, so the sending process keeps answering. sharp picks the binary for the platform: a
 * native one on the server, its wasm32 build on the phone. It loads with the first image (60–250 ms, kept off startup).
 * Electron processes draw with nativeImage instead (electron/imagePreview.ts): sharp's libvips clashes with the glib
 * Electron loads on Linux. A format it cannot decode, or a binary that cannot load, rejects, and the offer warns it.
 */
export async function nodeImagePreview(original: Blob, contentType: string): Promise<Blob> {
  const { default: sharp } = await import('sharp')
  const png = contentType === 'image/png'
  const image = sharp(new Uint8Array(await original.arrayBuffer())).rotate().resize({ width: 560, withoutEnlargement: true })
  const bytes = await (png ? image.png() : image.jpeg({ quality: 80 })).toBuffer()
  return new Blob([new Uint8Array(bytes)], { type: png ? 'image/png' : 'image/jpeg' })
}
