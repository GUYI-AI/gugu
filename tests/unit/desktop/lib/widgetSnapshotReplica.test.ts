// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * A widget's picture as the slot reads it (`widgetSnapshot`, an account replica of this device's picture store): the read
 * asks the store at the bucket's width, a picture is a data URL, none kept is `null`; the capture's write is put straight
 * into the entry the slots read (❌ a window event telling them to read the store again).
 */
const store = vi.hoisted(() => ({ read: vi.fn(), capture: vi.fn(() => ({ accountId: 'reader', generation: 0 }) as null | { accountId: string; generation: number }) }))
vi.mock('../../../../apps/desktop/src/lib/widgetSnapshots', async (original) => ({ ...(await original<object>()), widgetSnapshots: store }))
const { widgetSnapshot, widgetSnapshotDataUrl } = await import('../../../../apps/desktop/src/lib/widgetSnapshot')
const { widgetWidthBucket } = await import('../../../../apps/desktop/src/lib/widgetSnapshots')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')

beforeEach(() => {
  followRendererSession('SIGNED_IN', 'reader')
  queryClient.clear()
  store.read.mockReset()
  store.capture.mockReset().mockReturnValue({ accountId: 'reader', generation: 0 })
})

describe('widgetSnapshot', () => {
  it('reads the store at the bucket\'s width: a picture as a data URL, none as null', async () => {
    store.read.mockResolvedValueOnce(new Blob(['webp'], { type: 'image/webp' })).mockResolvedValueOnce(null)
    expect(widgetWidthBucket(415)).toBe(10)
    expect(await widgetSnapshot.fetch('w', 'light', 10)).toMatch(/^data:image\/webp;base64,/)
    expect(store.read).toHaveBeenCalledWith('w', 'light', 400)
    expect(await widgetSnapshot.fetch('w', 'dark', 10)).toBeNull()
  })

  it('a picture the capture stored is put into the entry the slots read, without reading the store again', async () => {
    store.read.mockResolvedValue(null)
    await widgetSnapshot.fetch('w', 'light', 10)
    widgetSnapshot.at('w', 'light', 10).set(await widgetSnapshotDataUrl(new Blob(['new'], { type: 'image/webp' })))
    const reading = widgetSnapshot.peek('w', 'light', 10)
    expect(reading.state === 'value' && reading.value).toMatch(/^data:image\/webp;base64,/)
    expect(store.read).toHaveBeenCalledTimes(1)
  })

  it('DE-3: the picture store not open for the account yet is not "no picture": an error, read again when asked again', async () => {
    store.capture.mockReturnValueOnce(null)
    await expect(widgetSnapshot.fetch('w', 'light', 10)).rejects.toThrow()
    expect(store.read).not.toHaveBeenCalled()
    store.read.mockResolvedValueOnce(new Blob(['webp'], { type: 'image/webp' }))
    expect(await widgetSnapshot.fetch('w', 'light', 10)).toMatch(/^data:image\/webp;base64,/)
  })
})
