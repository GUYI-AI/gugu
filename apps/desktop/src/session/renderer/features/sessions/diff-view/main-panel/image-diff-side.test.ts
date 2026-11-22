import { notifyManager } from '@tanstack/react-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const files = vi.hoisted(() => ({ readImage: vi.fn(), getImageAtRef: vi.fn() }))
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({
  workspaceRpc: () => ({ files: { readImage: files.readImage }, gitWorktree: { getImageAtRef: files.getImageAtRef } }),
  workspaceEvents: { on: () => () => undefined },
}))
vi.mock('@renderer/features/sessions/session-view-context', () => ({ useWorkspace: () => ({}) }))
vi.mock('@renderer/localization/use-session-messages', () => ({ useSessionMessages: () => ({ translate: (key: string) => key }) }))

const { followRendererSession, queryClient } = await import('@/lib/replica')
const { workspaceImage, IMAGE_RETRY_DELAYS_MS } = await import('@renderer/features/sessions/workspace-backend/workspace-image')

beforeEach(() => { notifyManager.setScheduler((callback) => { callback() }); vi.useFakeTimers(); followRendererSession('SIGNED_IN', 'tester') })
afterEach(() => { queryClient.clear(); vi.useRealTimers(); vi.clearAllMocks() })

describe('a working-tree image (the diff\'s working-tree side, a markdown image)', () => {
  it('a working-tree image caught mid-write is read again until it settles (the retry is the model\'s, ❌ a loop in the reader)', async () => {
    files.readImage
      .mockResolvedValueOnce({ success: true, data: { success: false, error: 'EBUSY' } })
      .mockResolvedValueOnce({ success: true, data: { success: true, dataUrl: 'data:image/png;base64,AA', mimeType: 'image/png', size: 1 } })
    const read = workspaceImage.fetch('p', 'w', 'logo.png')
    await vi.advanceTimersByTimeAsync(IMAGE_RETRY_DELAYS_MS[0]!)
    await expect(read).resolves.toMatchObject({ dataUrl: 'data:image/png;base64,AA', size: 1 })
    expect(files.readImage).toHaveBeenCalledTimes(2)
  })

  it('a failure that outlasts the retries is an error reading, ❌ a value drawn as "Preview unavailable" in the meantime', async () => {
    files.readImage.mockResolvedValue({ success: false, error: { type: 'io' } })
    const read = workspaceImage.fetch('p', 'w', 'busy.png').catch((error: unknown) => error)
    await vi.advanceTimersByTimeAsync(IMAGE_RETRY_DELAYS_MS.reduce((a, b) => a + b, 0))
    expect(await read).toBeInstanceOf(Error)
    expect(files.readImage).toHaveBeenCalledTimes(IMAGE_RETRY_DELAYS_MS.length + 1)
    expect(workspaceImage.peek('p', 'w', 'busy.png')).toMatchObject({ state: 'error' })
  })

  it('a file that is not there is null (the diff says added / deleted), not an error', async () => {
    files.readImage.mockResolvedValueOnce({ success: true, data: { success: false, error: 'ENOENT: not found' } })
    await expect(workspaceImage.fetch('p', 'w', 'gone.png')).resolves.toBeNull()
  })
})
