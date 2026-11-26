import { beforeEach, describe, expect, it, vi } from 'vitest'

const test = vi.hoisted(() => ({ order: [] as string[], logout: vi.fn(), forget: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: { logout: test.logout } }))
vi.mock('@/session/renderer/features/projects/stores/account-projects-cache', () => ({ forgetCachedAccountProjects: test.forget }))

import { finishSignedOut, logout } from '../../../../apps/desktop/src/lib/authLogout'

beforeEach(() => {
  vi.clearAllMocks(); test.order = []
  test.logout.mockImplementation(async () => { test.order.push('logout'); return { success: true } })
  test.forget.mockImplementation(() => { test.order.push('forget') })
})
describe('sign-out tail', () => {
  it('logout signs out live, then clears caches and reports, in place', async () => {
    const onSignedOut = vi.fn(() => { test.order.push('signed-out') })
    expect(await logout(onSignedOut)).toEqual({ success: true })
    expect(test.order).toEqual(['logout', 'forget', 'signed-out'])
  })
  it('a failed sign-out runs no part of the tail', async () => {
    test.logout.mockResolvedValueOnce({ success: false })
    const onSignedOut = vi.fn()
    expect(await logout(onSignedOut)).toEqual({ success: false })
    expect(test.forget).not.toHaveBeenCalled(); expect(onSignedOut).not.toHaveBeenCalled()
  })
  it('the shared tail never signs out again', () => {
    const onSignedOut = vi.fn()
    finishSignedOut(onSignedOut)
    expect(test.order).toEqual(['forget']); expect(onSignedOut).toHaveBeenCalledOnce()
    expect(test.logout).not.toHaveBeenCalled()
  })
})
