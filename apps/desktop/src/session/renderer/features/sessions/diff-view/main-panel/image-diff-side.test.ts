import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => ({ readImage: vi.fn(), getImageAtRef: vi.fn() }))
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({
  workspaceRpc: () => ({ files: { readImage: files.readImage }, gitWorktree: { getImageAtRef: files.getImageAtRef } }),
}))
vi.mock('@renderer/features/sessions/session-view-context', () => ({ useWorkspace: () => ({}) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))

const { queryClient } = await import('@/lib/replica')
const { imageDiffSide, IMAGE_RETRY_DELAYS_MS } = await import('./image-diff-view')

const file = { path: 'logo.png', group: 'disk' as const, originalRef: 'HEAD', modifiedRef: null }

beforeEach(() => { notifyManager.setScheduler((callback) => { callback() }); vi.useFakeTimers() })
afterEach(() => { queryClient.clear(); vi.useRealTimers(); vi.clearAllMocks() })

describe('an image diff side', () => {
  it('a working-tree image caught mid-write is read again until it settles (the retry is the model\'s, ❌ a loop in the reader)', async () => {
    files.readImage
      .mockResolvedValueOnce({ success: true, data: { success: false, error: 'EBUSY' } })
      .mockResolvedValueOnce({ success: true, data: { success: true, dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png', size: 1 } })
    const read = imageDiffSide.fetch('p', 'w', 'modified', file, 7)
    await vi.advanceTimersByTimeAsync(IMAGE_RETRY_DELAYS_MS[0]!)
    await expect(read).resolves.toMatchObject({ status: 'ready', size: 1 })
    expect(files.readImage).toHaveBeenCalledTimes(2)
  })

  it('a failure that outlasts the retries is an error reading, ❌ a value drawn as "Preview unavailable" in the meantime', async () => {
    files.readImage.mockResolvedValue({ success: false, error: { type: 'io' } })
    const read = imageDiffSide.fetch('p', 'w', 'modified', file, 8).catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(IMAGE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0))
    expect(await read).toBeInstanceOf(Error)
    expect(files.readImage).toHaveBeenCalledTimes(IMAGE_RETRY_DELAYS_MS.length + 1)
    expect(imageDiffSide.peek('p', 'w', 'modified', file, 8)).toMatchObject({ state: 'error' })
  })

  it('a file that is not there is a value (added / deleted), not an error', async () => {
    files.readImage.mockResolvedValueOnce({ success: true, data: { success: false, error: 'ENOENT: not found' } })
    await expect(imageDiffSide.fetch('p', 'w', 'modified', file, 9)).resolves.toEqual({ status: 'missing' })
  })
})
