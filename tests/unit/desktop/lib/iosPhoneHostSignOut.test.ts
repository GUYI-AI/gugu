import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ ownerId: '11111111-1111-4111-8111-111111111111' as string | null,
  prepare: vi.fn(), authSession: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true,
  getPlatform: () => 'ios', isPluginAvailable: () => true }, registerPlugin: () => ({ authSession: state.authSession }) }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({
  getRendererSession: () => state.ownerId ? { user: { id: state.ownerId } } : null,
  observeRendererSession: () => () => {},
}))
vi.mock('../../../../apps/desktop/src/mobile/ios-runtime/iosOwnerClient', () => ({ prepareIOSSignOut: state.prepare }))
import { phoneHostSignOut } from '../../../../apps/desktop/src/lib/phoneHostAuth'

beforeEach(() => { vi.resetAllMocks(); state.ownerId = '11111111-1111-4111-8111-111111111111' })
describe('iOS sign-out ordering', () => {
  it('finishes native authenticated cleanup before the SDK revokes its session', async () => {
    const order: string[] = []
    let finish!: () => void
    state.prepare.mockImplementation(() => new Promise<void>(resolve => { finish = () => { order.push('cleanup'); resolve() } }))
    const revoke = vi.fn(async () => { order.push('revoke'); return { error: null } })
    const pending = phoneHostSignOut(revoke)
    await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledWith(state.ownerId))
    expect(revoke).not.toHaveBeenCalled()
    finish()
    await expect(pending).resolves.toEqual({ error: null })
    expect(order).toEqual(['cleanup', 'revoke'])
    expect(state.authSession).not.toHaveBeenCalled()
  })
  it('does not revoke or clear the login when native verification/cleanup fails', async () => {
    const failure = { code: 'auth_check_failed' }
    state.prepare.mockRejectedValue(failure)
    const revoke = vi.fn()
    await expect(phoneHostSignOut(revoke)).rejects.toBe(failure)
    expect(revoke).not.toHaveBeenCalled()
  })
  it('preserves an SDK failure after successful native cleanup', async () => {
    state.prepare.mockResolvedValue(undefined)
    const error = new Error('network unavailable')
    await expect(phoneHostSignOut(async () => ({ error }))).resolves.toEqual({ error })
  })
  it('rejects a missing current owner without any native or SDK mutation', async () => {
    state.ownerId = null
    const revoke = vi.fn()
    await expect(phoneHostSignOut(revoke)).rejects.toThrow('Current login')
    expect(state.prepare).not.toHaveBeenCalled(); expect(revoke).not.toHaveBeenCalled()
  })
})
