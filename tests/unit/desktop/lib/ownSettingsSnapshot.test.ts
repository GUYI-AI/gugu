// @vitest-environment jsdom
import { notifyManager } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * The `user` settings row (first run, the tour, hints, occupation, file storage) is drawn from the first frame after a
 * restart. Groups' rows (pinned topics) shared its snapshot slots, so opening four groups pushed it out and the next
 * start began unknown. Each now has its own slots.
 */
vi.mock('@gugu/core/cloud/userSettings', () => ({
  readUserSettingsConfig: vi.fn(async (_client: unknown, _user: string, scope: string) => ({ scope })),
  updateUserSettingsConfig: vi.fn(),
  updateUserSettingsKey: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ identityDb: {} }))

beforeEach(() => {
  notifyManager.setScheduler((callback) => { callback() })
  localStorage.clear()
  vi.resetModules()
})

describe('own settings across restarts', () => {
  it('the user row stays after many groups were opened, and the most recent groups\' pins stay too', async () => {
    const rm = await import('../../../../apps/desktop/src/lib/replica')
    rm.followRendererSession('SIGNED_IN', 'alice')
    const settings = await import('../../../../apps/desktop/src/lib/ownSettings')
    await settings.readOwnSettings('alice', 'user')
    for (let n = 1; n <= 6; n += 1) {
      await settings.readOwnSettings('alice', `chat:${n}`)
      await new Promise((resolve) => setTimeout(resolve, 2))
    }
    const kept = Object.values(JSON.parse(localStorage.getItem('gugu.readModel.v1:alice') ?? '{}') as Record<string, { key: string[] }>)
      .map((entry) => entry.key[2]).sort()
    expect(kept).toEqual(['chat:3', 'chat:4', 'chat:5', 'chat:6', 'user'])
  })
})
