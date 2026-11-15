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
  // Real JPEG encodings of the same 37×11 pixels naming an EXIF orientation: 5–8 are shown turned a quarter.
  it.each([
    [3, '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAMAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAALACUDASIAAhEBAxEB', { width: 37, height: 11 }],
    [6, '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAALACUDASIAAhEBAxEB', { width: 11, height: 37 }],
    [8, '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAgAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAALACUDASIAAhEBAxEB', { width: 11, height: 37 }],
    // EXIF orientation 6 followed by an XMP packet (also APP1), as edited and many phone photos carry.
    ['6 then XMP', '/9j/4AAQSkZJRgABAQAAAQABAAD/4QAiRXhpZgAATU0AKgAAAAgAAQESAAMAAAABAAYAAAAAAAD/4QDsaHR0cDovL25zLmFkb2JlLmNvbS94YXAvMS4wLwA8eDp4bXBtZXRhIHhtbG5zOng9ImFkb2JlOm5zOm1ldGEvIj48cmRmOlJERiB4bWxuczpyZGY9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkvMDIvMjItcmRmLXN5bnRheC1ucyMiPjxyZGY6RGVzY3JpcHRpb24geG1sbnM6dGlmZj0iaHR0cDovL25zLmFkb2JlLmNvbS90aWZmLzEuMC8iIHRpZmY6T3JpZW50YXRpb249IjYiLz48L3JkZjpSREY+PC94OnhtcG1ldGE+/9sAQwAIBgYHBgUIBwcHCQkICgwUDQwLCwwZEhMPFB0aHx4dGhwcICQuJyAiLCMcHCg3KSwwMTQ0NB8nOT04MjwuMzQy/9sAQwEJCQkMCwwYDQ0YMiEcITIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIy/8AAEQgACwAlAwEiAAIRAQMRAQ==', { width: 11, height: 37 }],
  ] as const)('reads a JPEG with EXIF orientation %s as it is shown', (_orientation, base64, shown) => {
    expect(imagePixelSize(Buffer.from(base64, 'base64'))).toEqual(shown)
  })
  it('says nothing for other bytes, a header cut before its size, or a zero size', () => {
    expect(imagePixelSize(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
    expect(imagePixelSize(Buffer.from(encoded[1][1], 'base64').subarray(0, 100))).toBeNull()
    const png = Buffer.from(encoded[0][1], 'base64'); png.writeUInt32BE(0, 16)
    expect(imagePixelSize(png)).toBeNull()
  })
})
