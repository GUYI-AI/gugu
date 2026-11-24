import { describe, expect, it } from 'vitest'
import { imageCommandHandlers, imagePreview, scaleImage } from '@/lib/imagePreview'

async function picture(width: number, height: number, type = 'image/png'): Promise<Blob> {
  const canvas = new OffscreenCanvas(width, height)
  const context = canvas.getContext('2d')!
  context.fillStyle = '#c33'; context.fillRect(0, 0, width, height)
  return await canvas.convertToBlob({ type })
}

async function sizeOf(blob: Blob): Promise<[number, number]> {
  const bitmap = await createImageBitmap(blob)
  try { return [bitmap.width, bitmap.height] } finally { bitmap.close() }
}

describe('scaleImage: the one image scaler for the renderer and for Electron main', () => {
  it('draws a preview no wider than 560 px, as WebP', async () => {
    const preview = await imagePreview(await picture(1200, 800))
    expect(preview.type).toBe('image/webp')
    expect(await sizeOf(preview)).toEqual([560, 373])
  })

  it('fits the long edge for main\'s shrink and writes JPEG at the given quality', async () => {
    const scaled = await scaleImage(await picture(800, 1200, 'image/jpeg'), { fit: 'edge', max: 1024, type: 'image/jpeg', quality: 0.72 })
    expect([scaled.width, scaled.height]).toEqual([683, 1024])
    expect(scaled.blob.type).toBe('image/jpeg')
    expect(await sizeOf(scaled.blob)).toEqual([683, 1024])
  })

  it('smooths a large reduction: a noisy photo\'s preview is not the speckled, larger one the default smoothing draws', async () => {
    const canvas = new OffscreenCanvas(4032, 3024), context = canvas.getContext('2d')!
    const pixels = context.createImageData(4032, 3024)
    for (let i = 0; i < pixels.data.length; i += 4) { const v = 120 + Math.floor(Math.random() * 40); pixels.data.set([v, v, v, 255], i) }
    context.putImageData(pixels, 0, 0)
    const photo = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 })
    const bitmap = await createImageBitmap(photo), aliased = new OffscreenCanvas(560, 420)
    aliased.getContext('2d')!.drawImage(bitmap, 0, 0, 560, 420); bitmap.close()
    const speckled = await aliased.convertToBlob({ type: 'image/webp' })
    expect((await imagePreview(photo)).size).toBeLessThan(speckled.size / 2)
  })

  it('never enlarges a small image', async () => {
    expect(await sizeOf(await imagePreview(await picture(300, 200)))).toEqual([300, 200])
  })

  it('answers main\'s `images` command with bytes main can upload', async () => {
    const bytes = new Uint8Array(await (await picture(1200, 800)).arrayBuffer())
    const answer = await imageCommandHandlers.scale({ bytes, contentType: 'image/png', fit: 'width', max: 560, type: 'image/webp' })
    expect(answer.type).toBe('image/webp')
    expect([answer.width, answer.height]).toEqual([560, 373])
    expect(await sizeOf(new Blob([answer.bytes], { type: answer.type }))).toEqual([560, 373])
  })

  it('rejects bytes it cannot decode', async () => {
    await expect(imageCommandHandlers.scale({ bytes: new Uint8Array([1, 2, 3]), contentType: 'image/jpeg', fit: 'width', max: 560, type: 'image/webp' })).rejects.toThrow()
  })
})
