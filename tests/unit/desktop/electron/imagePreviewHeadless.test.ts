import { describe, expect, it, vi } from 'vitest'

// A gugu server runs this same main with `electron` pinned to the server shim (server = the desktop without a window).
vi.mock('electron', async () => await import('../../../../apps/desktop/electron/server/server-electron-shim'))

const { nativeImagePreview } = await import('../../../../apps/desktop/electron/imagePreview')

/**
 * An agent on a gugu server sending a 1.6 MB PNG offered the original itself as the image's "560 px preview": the shim
 * read it as a non-empty image of size 0×0 (so it was never resized) and handed its bytes back from toPNG. A reader that
 * reads a preview in one chunk said "Image unavailable right now". With no decoder the server offers no preview, and
 * readers show the original.
 */
describe('an image preview on a gugu server (no image decoder)', () => {
  it('is not offered, rather than the original passed off as one', async () => {
    const png = new Uint8Array(1_617_526)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    expect(await nativeImagePreview(new Blob([png], { type: 'image/png' }), 'image/png')).toBeNull()
  })
})
