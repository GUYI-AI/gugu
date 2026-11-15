/**
 * An image's pixel size, read from its header (PNG, JPEG, GIF, WebP), as the backend reads a managed upload's:
 * what a reader lays the image out by before any of its bytes arrive. Null when the header says nothing usable.
 */
export function imagePixelSize(b: Uint8Array): { width: number; height: number } | null {
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to))
  const u16be = (i: number) => (b[i]! << 8) | b[i + 1]!
  const u16le = (i: number) => b[i]! | (b[i + 1]! << 8)
  const u24le = (i: number) => b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16)
  const u32be = (i: number) => ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0
  const size = (width: number, height: number) => width > 0 && height > 0 ? { width, height } : null
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 4) === 'PNG' && ascii(4, 8) === '\r\n\x1a\n'
    && u32be(8) === 13 && ascii(12, 16) === 'IHDR') return u32be(16) <= 0x7fffffff && u32be(20) <= 0x7fffffff ? size(u32be(16), u32be(20)) : null
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return size(u16le(6), u16le(8))
  if (b.length >= 25 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16)
    const chunkBytes = (b[16]! | (b[17]! << 8) | (b[18]! << 16) | (b[19]! << 24)) >>> 0
    if ((chunk === 'VP8L' && chunkBytes < 5) || ((chunk === 'VP8 ' || chunk === 'VP8X') && chunkBytes < 10)) return null
    if (chunk === 'VP8 ' && b.length >= 30 && (b[20]! & 1) === 0 && ascii(23, 26) === '\x9d\x01\x2a') return size(u16le(26) & 0x3fff, u16le(28) & 0x3fff)
    if (chunk === 'VP8L' && b[20] === 0x2f && (b[24]! & 0xe0) === 0) { const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0; return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) }
    // RFC 9649 要求读取器忽略 VP8X 保留位，尺寸只取画布字段。
    if (chunk === 'VP8X' && b.length >= 30) return size(u24le(24) + 1, u24le(27) + 1)
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the segments to the frame header (SOF0–SOF15 except DHT C4, JPG C8, DAC CC). An EXIF orientation of 5–8 (APP1,
    // IFD0 tag 0x0112) turns the image a quarter: it is shown, and laid out, with width and height swapped.
    let turned = false
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null
      if (b[i + 1] === 0xff) { i++; continue }
      const marker = b[i + 1]!
      if (marker === 0xda || marker === 0xd9) return null
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      if (marker === 0xe1) {
        // An XMP packet is APP1 too, often right after the EXIF one: only the EXIF segment names the orientation.
        const o = exifOrientation(b, i + 4, i + 2 + u16be(i + 2))
        if (o !== null) turned = o >= 5 && o <= 8
      }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        if (u16be(i + 2) < 8) return null
        return turned ? size(u16be(i + 5), u16be(i + 7)) : size(u16be(i + 7), u16be(i + 5))
      }
      i += 2 + u16be(i + 2)
    }
  }
  return null
}

/** APP1 段内的 EXIF 方向；段不合法或未声明方向时返回 null，保留已读到的方向。 */
function exifOrientation(b: Uint8Array, at: number, end: number): number | null {
  if (end > b.length || String.fromCharCode(...b.subarray(at, at + 6)) !== 'Exif\0\0') return null
  if (at + 14 > end) return null
  const t = at + 6, le = b[t] === 0x49 && b[t + 1] === 0x49
  const u16 = (i: number) => (i + 2 > end ? -1 : le ? b[i]! | (b[i + 1]! << 8) : (b[i]! << 8) | b[i + 1]!)
  const u32 = (i: number) => (le ? (b[i]! | (b[i + 1]! << 8) | (b[i + 2]! << 16) | (b[i + 3]! << 24)) >>> 0 : ((b[i]! << 24) | (b[i + 1]! << 16) | (b[i + 2]! << 8) | b[i + 3]!) >>> 0)
  if ((!le && !(b[t] === 0x4d && b[t + 1] === 0x4d)) || u16(t + 2) !== 42) return null
  const offset = u32(t + 4), ifd = t + offset
  if (offset < 8 || ifd + 2 > end) return null
  for (let k = 0, n = u16(ifd); k < n; k++) {
    const entry = ifd + 2 + 12 * k
    if (entry + 12 > end) return null
    if (u16(entry) === 0x0112) {
      if (u16(entry + 2) !== 3 || u32(entry + 4) !== 1) return null
      const orientation = u16(entry + 8)
      return orientation >= 1 && orientation <= 8 ? orientation : null
    }
  }
  return null
}
