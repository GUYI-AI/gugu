import { beforeEach, describe, expect, it, vi } from 'vitest'

const test = vi.hoisted(() => ({
  order: [] as string[], appRelaunch: true,
  logout: vi.fn(), relaunch: vi.fn(), forget: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  capabilities: { get appRelaunch() { return test.appRelaunch } }, relaunchApp: test.relaunch,
} }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: { logout: test.logout } }))
vi.mock('@/session/renderer/features/projects/stores/account-projects-cache', () => ({ forgetCachedAccountProjects: test.forget }))

import { finishSignedOut, logoutAndRelaunch } from '../../../../apps/desktop/src/lib/authLogout'

beforeEach(() => {
  vi.clearAllMocks(); test.order = []; test.appRelaunch = true
  test.logout.mockImplementation(async () => { test.order.push('logout'); return { success: true } })
  test.relaunch.mockImplementation(async () => { test.order.push('relaunch') })
  test.forget.mockImplementation(() => { test.order.push('forget') })
})
describe('sign-out tail', () => {
  it('logoutAndRelaunch signs out live, then clears caches, reports, and restarts once', async () => {
    const onSignedOut = vi.fn(() => { test.order.push('signed-out') })
    expect(await logoutAndRelaunch(onSignedOut)).toEqual({ success: true })
    expect(test.order).toEqual(['logout', 'forget', 'signed-out', 'relaunch'])
  })
  it('a failed sign-out runs no part of the tail', async () => {
    test.logout.mockResolvedValueOnce({ success: false })
    const onSignedOut = vi.fn()
    expect(await logoutAndRelaunch(onSignedOut)).toEqual({ success: false })
    expect(test.forget).not.toHaveBeenCalled(); expect(onSignedOut).not.toHaveBeenCalled(); expect(test.relaunch).not.toHaveBeenCalled()
  })
  it('the shared tail never signs out again and restarts only where the platform can', async () => {
    const onSignedOut = vi.fn()
    test.appRelaunch = false
    await finishSignedOut(onSignedOut)
    expect(test.order).toEqual(['forget']); expect(onSignedOut).toHaveBeenCalledOnce()
    expect(test.logout).not.toHaveBeenCalled(); expect(test.relaunch).not.toHaveBeenCalled()
  })
})
