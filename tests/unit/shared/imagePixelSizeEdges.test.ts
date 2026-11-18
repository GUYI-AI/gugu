import { describe, expect, it } from 'vitest'
import { imagePixelSize } from '@gugu/core/shared/imagePixelSize'

const lossless = Buffer.from('UklGRh4AAABXRUJQVlA4TBEAAAAvJIACAAdQhSJXof+BiOh/AAA=', 'base64')
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACUAAAALCAIAAAB3WtMSAAAAHElEQVR4nGM8wcXFQEfARE/LRu0btW/UvhFlHwBbwgDymT3VBQAAAABJRU5ErkJggg==', 'base64')
const lossy = Buffer.from('UklGRkgAAABXRUJQVlA4IDwAAAAQAwCdASolAAsAPm0wlEckIyIhKqgAgA2JYwB2AACspoAA/vIiX//sWctgSg//+5wP+5wP+5wP4rHJAAA=', 'base64')
const frame = Buffer.from([0xff, 0xc0, 0, 11, 8, 0, 11, 0, 37, 1, 1, 0x11, 0])
const exifPayload = () => {
  const payload = Buffer.alloc(32)
  payload.write('Exif\0\0', 0, 'ascii'); payload.write('II', 6, 'ascii')
  payload.writeUInt16LE(42, 8); payload.writeUInt32LE(8, 10)
  payload.writeUInt16LE(1, 14); payload.writeUInt16LE(0x0112, 16)
  payload.writeUInt16LE(3, 18); payload.writeUInt32LE(1, 20); payload.writeUInt16LE(6, 24)
  return payload
}
const exifJpeg = (payload: Buffer) => {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0, 0])
  header.writeUInt16BE(payload.length + 2, 4)
  return Buffer.concat([header, payload, frame])
}

describe('image header boundaries', () => {
  it('requires EXIF SHORT orientation with one value and a valid TIFF header', () => {
    for (const [offset, value] of [[18, 4], [20, 2], [6, 0], [8, 0]]) {
      const payload = exifPayload(); payload[offset] = value
      expect(imagePixelSize(exifJpeg(payload))).toEqual({ width: 37, height: 11 })
    }
    const payload = exifPayload(); payload.writeUInt16LE(9, 24)
    expect(imagePixelSize(exifJpeg(payload))).toEqual({ width: 37, height: 11 })
  })
  it('ignores an EXIF directory entry cut by its APP1 segment boundary', () => {
    expect(imagePixelSize(exifJpeg(exifPayload().subarray(0, 26)))).toEqual({ width: 37, height: 11 })
    expect(imagePixelSize(exifJpeg(exifPayload()))).toEqual({ width: 11, height: 37 })
  })
  it('does not interpret bytes beyond the JPEG scan or end marker as frame headers', () => {
    for (const marker of [0xda, 0xd9]) {
      expect(imagePixelSize(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, marker, 0, 2]), frame]))).toBeNull()
    }
  })
  it('skips repeated JPEG marker fill bytes', () => {
    const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xff]), frame])
    expect(imagePixelSize(jpeg)).toEqual({ width: 37, height: 11 })
  })
  it('requires VP8 and VP8L frame signatures before reading dimensions', () => {
    const invalidLossless = Buffer.from(lossless); invalidLossless[20] = 0
    const invalidLossy = Buffer.from(lossy); invalidLossy[23] = 0
    expect(imagePixelSize(invalidLossless)).toBeNull()
    expect(imagePixelSize(invalidLossy)).toBeNull()
    expect(imagePixelSize(lossy)).toEqual({ width: 37, height: 11 })
  })
  it('requires the complete PNG signature and the IHDR length', () => {
    for (const offset of [4, 5, 6, 7, 11]) {
      const broken = Buffer.from(png)
      broken[offset] ^= 1
      expect(imagePixelSize(broken)).toBeNull()
    }
    expect(imagePixelSize(png)).toEqual({ width: 37, height: 11 })
  })
  it('reads dimensions from the complete 25-byte VP8L header', () => {
    expect(imagePixelSize(lossless.subarray(0, 25))).toEqual({ width: 37, height: 11 })
    expect(imagePixelSize(lossless.subarray(0, 24))).toBeNull()
  })
})
