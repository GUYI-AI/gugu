import { describe, expect, it } from 'vitest'
import { imagePixelSize } from '@gugu/core/shared/imagePixelSize'

// Real 37×11 encodings (the JPEG cut right after its frame header: only the header is read).
const encoded = [
  ['png', 'iVBORw0KGgoAAAANSUhEUgAAACUAAAALCAIAAAB3WtMSAAAAHElEQVR4nGM8wcXFQEfARE/LRu0btW/UvhFlHwBbwgDymT3VBQAAAABJRU5ErkJggg=='],
  ['jpeg with an Exif segment', '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAWRXhpZgAATU0AKgAAAAgAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAALACUDASI='],
  ['gif', 'R0lGODdhJQALAIEAAMgKCgAAAAAAAAAAACwAAAAAJQALAAAIIwABCBxIsKDBgwgTKlzIsKHDhxAjSpxIsaLFixgzatzIEUBAADs='],
  ['lossy webp', 'UklGRkgAAABXRUJQVlA4IDwAAAAQAwCdASolAAsAPm0wlEckIyIhKqgAgA2JYwB2AACspoAA/vIiX//sWctgSg//+5wP+5wP+5wP4rHJAAA='],
  ['lossless webp', 'UklGRh4AAABXRUJQVlA4TBEAAAAvJIACAAdQhSJXof+BiOh/AAA='],
  ['extended webp', 'UklGRm4AAABXRUJQVlA4WAoAAAAYAAAAJAAACgAAQUxQSA8AAAABB0AgaYu3/RERR0T0PwAAVlA4ICYAAADQAgCdASolAAsAPm0wlEckIyIhKqgAgA2JaQAAUfYAAP77eMAAAEVYSUYKAAAATU0AKgAAAAgAAA=='],
] as const

describe('an image\'s pixel size from its header', () => {
  it.each(encoded)('reads a %s', (_format, base64) => {
    expect(imagePixelSize(Buffer.from(base64, 'base64'))).toEqual({ width: 37, height: 11 })
  })
  it('says nothing for other bytes, a header cut before its size, or a zero size', () => {
    expect(imagePixelSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imagePixelSize(Buffer.from(encoded[1][1], 'base64').subarray(0, 100))).toBeNull()
    const png = Buffer.from(encoded[0][1], 'base64'); png.writeUInt32BE(0, 16)
    expect(imagePixelSize(png)).toBeNull()
  })
})
