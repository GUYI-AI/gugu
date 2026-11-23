import { describe, expect, it, vi } from 'vitest'

// The server shim pinned as `electron`, the way a gugu server boots this same main (server = the desktop without a window).
vi.mock('electron', async () => await import('../../../../apps/desktop/electron/server/server-electron-shim'))

const { nativeImagePreview } = await import('../../../../apps/desktop/electron/imagePreview')

/**
 * An agent on a gugu server sending a 1.6 MB PNG offered the original itself as the image's "560 px preview": the shim
 * read it as a non-empty image of size 0×0 (so it was never resized) and handed its bytes back from toPNG. A reader that
 * reads a preview in one chunk said "Image unavailable right now". A server now draws with sharp (nodeImagePreview);
 * Electron's drawer on a process with no decoder must say it cannot decode, never pass the original off as its preview.
 */
describe('an image preview drawn by Electron with no image decoder (the server shim)', () => {
  it('rejects instead of passing the original off as the preview', async () => {
    const png = new Uint8Array(1_617_526)
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    await expect(nativeImagePreview(new Blob([png], { type: 'image/png' }), 'image/png')).rejects.toThrow('Electron cannot decode image/png')
  })
})
