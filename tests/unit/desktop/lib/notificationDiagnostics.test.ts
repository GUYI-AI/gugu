import { describe, expect, it, vi } from 'vitest'
import { readAndroidNotificationProblem, sendTestNotification } from '../../../../apps/desktop/src/lib/notificationDiagnostics'

const mocks = vi.hoisted(() => ({ read: vi.fn(), post: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({
  platform: {
    capabilities: { notifications: true },
    showNotification: mocks.post,
    androidNotificationSettings: { read: mocks.read },
  },
}))

describe('Android notification diagnostics', () => {
  it.each([
    [{ enabled: false, importance: 4 }, 'app-disabled'],
    [{ enabled: true, importance: 0 }, 'channel-disabled'],
    [{ enabled: true, importance: 2 }, 'below-high'],
    [{ enabled: true, importance: 3 }, 'below-high'],
    [{ enabled: true, importance: 4 }, null],
    [{ enabled: true }, undefined],
  ])('interprets only Android notification settings in %j', async (status, expected) => {
    mocks.read.mockResolvedValue(status)
    await expect(readAndroidNotificationProblem(false)).resolves.toBe(expected)
  })

  it('uses the selected sound preference for an explicit test', async () => {
    mocks.post.mockResolvedValue({ displayed: true })
    await expect(sendTestNotification(true)).resolves.toEqual({ kind: 'accepted' })
    expect(mocks.post).toHaveBeenCalledWith(expect.objectContaining({ silent: true, chatId: null }))
  })
})
