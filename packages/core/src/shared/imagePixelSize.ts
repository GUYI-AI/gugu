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
  if (b.length >= 24 && b[0] === 0x89 && ascii(1, 4) === 'PNG' && ascii(12, 16) === 'IHDR') return size(u32be(16), u32be(20))
  if (b.length >= 10 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return size(u16le(6), u16le(8))
  if (b.length >= 30 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    const chunk = ascii(12, 16)
    if (chunk === 'VP8 ') return size(u16le(26) & 0x3fff, u16le(28) & 0x3fff)
    if (chunk === 'VP8L') { const bits = (b[21]! | (b[22]! << 8) | (b[23]! << 16) | (b[24]! << 24)) >>> 0; return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1) }
    if (chunk === 'VP8X') return size(u24le(24) + 1, u24le(27) + 1)
    return null
  }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) {
    // Walk the segments to the frame header (SOF0–SOF15 except DHT C4, JPG C8, DAC CC).
    for (let i = 2; i + 9 < b.length; ) {
      if (b[i] !== 0xff) return null
      const marker = b[i + 1]!
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue }
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return size(u16be(i + 7), u16be(i + 5))
      i += 2 + u16be(i + 2)
    }
  }
  return null
}
