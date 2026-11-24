import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { nodeImagePreview } from '../../../../packages/core/src/local/files/nodeImagePreview'

// Real bytes through the real decoder: the drawer a plain-Node host (the gugu server) registers.
const encoded = async (width: number, height: number, as: 'png' | 'jpeg', orientation?: number) => {
  const image = sharp({ create: { width, height, channels: 4, background: { r: 200, g: 40, b: 40, alpha: 0.5 } } })
  const bytes = await (as === 'png' ? image.png() : image.jpeg()).withMetadata(orientation ? { orientation } : {}).toBuffer()
  return new Blob([new Uint8Array(bytes)], { type: `image/${as}` })
}
const shape = async (blob: Blob) => {
  const { width, height, format, hasAlpha } = await sharp(new Uint8Array(await blob.arrayBuffer())).metadata()
  return { width, height, format, hasAlpha }
}

describe('nodeImagePreview', () => {
  it('draws a JPEG 560 px wide, keeping its aspect', async () => {
    const preview = await nodeImagePreview(await encoded(4032, 3024, 'jpeg'), 'image/jpeg')
    expect(preview.type).toBe('image/jpeg')
    expect(await shape(preview)).toMatchObject({ width: 560, height: 420, format: 'jpeg' })
  })

  it('turns a photo upright by its EXIF orientation', async () => {
    const preview = await nodeImagePreview(await encoded(1200, 800, 'jpeg', 6), 'image/jpeg')
    expect(await shape(preview)).toMatchObject({ width: 560, height: 840 })
  })

  it('keeps a PNG a transparent PNG, and never enlarges a small image', async () => {
    const preview = await nodeImagePreview(await encoded(300, 200, 'png'), 'image/png')
    expect(preview.type).toBe('image/png')
    expect(await shape(preview)).toMatchObject({ width: 300, height: 200, format: 'png', hasAlpha: true })
  })

  it('rejects bytes it cannot decode', async () => {
    await expect(nodeImagePreview(new Blob([new Uint8Array([1, 2, 3])]), 'image/heic')).rejects.toThrow()
  })
})
