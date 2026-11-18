import { expect, it } from 'vitest'
import { imagePixelSize } from '@gugu/core/shared/imagePixelSize'
const frame = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 11, 0, 37, 1, 1, 0x11, 0])
const jpeg = (prefix: Buffer) => Buffer.concat([Buffer.from([0xff, 0xd8]), prefix, frame])
const webp = (kind: string, length: number, payload: number[]) => {
  const b = Buffer.alloc(20 + payload.length)
  b.write('RIFF')
  b.writeUInt32LE(b.length - 8, 4)
  b.write('WEBP', 8)
  b.write(kind, 12)
  b.writeUInt32LE(length, 16)
  b.set(payload, 20)
  return b
}

it('rejects a frame whose declared length does not contain its dimensions', () => {
  const broken = Buffer.from(frame)
  broken.writeUInt16BE(2, 2)
  expect(imagePixelSize(jpeg(Buffer.alloc(0)))).toEqual({ width: 37, height: 11 })
  expect(imagePixelSize(Buffer.concat([Buffer.from([255, 216]), broken]))).toBeNull()
})

it('rejects PNG dimensions above the signed 31-bit format limit', () => {
  const b = Buffer.alloc(24)
  b.set([137, 80, 78, 71, 13, 10, 26, 10])
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12)
  b.writeUInt32BE(0x80000000, 16)
  b.writeUInt32BE(1, 20)
  expect(imagePixelSize(b)).toBeNull()
})

it('rejects WebP size fields outside the declared chunk', () => {
  expect(imagePixelSize(webp('VP8L', 1, [47, 36, 128, 2, 0]))).toBeNull()
  expect(imagePixelSize(webp('VP8X', 1, [0, 0, 0, 0, 36, 0, 0, 10, 0, 0]))).toBeNull()
})

it('rejects unsupported VP8L version bits', () => {
  expect(imagePixelSize(webp('VP8L', 5, [47, 36, 128, 2, 224]))).toBeNull()
})

it('ignores nonzero VP8X reserved bits and bytes when reading dimensions', () => {
  for (const reserved of [[1, 0, 0, 0], [64, 0, 0, 0], [128, 0, 0, 0], [0, 1, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [193, 255, 255, 255]]) {
    expect(imagePixelSize(webp('VP8X', 10, [...reserved, 36, 0, 0, 10, 0, 0]))).toEqual({ width: 37, height: 11 })
  }
})

it('retains an orientation when a later EXIF segment names none', () => {
  const p = Buffer.alloc(32)
  p.write('Exif\0\0')
  p.write('II', 6)
  p.writeUInt16LE(42, 8)
  p.writeUInt32LE(8, 10)
  p.writeUInt16LE(1, 14)
  p.writeUInt16LE(274, 16)
  p.writeUInt16LE(3, 18)
  p.writeUInt32LE(1, 20)
  p.writeUInt16LE(6, 24)
  const a = Buffer.from([255, 225, 0, 34])
  const empty = Buffer.from(p)
  empty.writeUInt16LE(0, 14)
  expect(imagePixelSize(jpeg(Buffer.concat([a, p, a, empty])))).toEqual({ width: 11, height: 37 })
})
