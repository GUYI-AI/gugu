import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ owner: 'A', platform: 'android', v2: true, resume: vi.fn() }))
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => true, getPlatform: () => state.platform, isPluginAvailable: () => state.v2 } }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: state.owner } }) }))
vi.mock('../../../../apps/desktop/src/mobile/local-agent/nativeAgent', () => ({ nativeAgent: { resumeAfterAccountClosure: state.resume } }))
import { resumePhoneAfterAccountClosure } from '../../../../apps/desktop/src/mobile/phone-device/phoneAccountClosureResume'

beforeEach(() => { state.owner = 'A'; state.platform = 'android'; state.v2 = true; state.resume.mockReset().mockResolvedValue({ resumed: true }) })
describe('explicit phone resume after cancellation', () => {
  it('requires the same native release ACK on an iOS V2 shell', async () => {
    state.platform = 'ios'; const commit = vi.fn()
    state.resume.mockRejectedValueOnce(Object.assign(new Error('Still sealed'), { code: 'closure_recovery_required' }))
    await expect(resumePhoneAfterAccountClosure('A', commit)).rejects.toMatchObject({ code: 'closure_recovery_required' })
    expect(commit).not.toHaveBeenCalled()
  })
  it('commits one explicit preference choice only after native acknowledges the original owner', async () => {
    const commit = vi.fn(); await resumePhoneAfterAccountClosure('A', commit)
    expect(state.resume).toHaveBeenCalledExactlyOnceWith({ ownerId: 'A' }); expect(commit).toHaveBeenCalledOnce()
  })
  it('a native refusal or malformed ACK cannot set preferences or fall through to ordinary configuration', async () => {
    const commit = vi.fn(), failure = Object.assign(new Error('Pending'), { code: 'closure_recovery_required' })
    state.resume.mockRejectedValueOnce(failure)
    await expect(resumePhoneAfterAccountClosure('A', commit)).rejects.toBe(failure)
    state.resume.mockResolvedValueOnce({ resumed: false })
    await expect(resumePhoneAfterAccountClosure('A', commit)).rejects.toMatchObject({ code: 'closure_unavailable' })
    expect(commit).not.toHaveBeenCalled()
  })
  it('B before or during the native request prevents A preference changes', async () => {
    const commit = vi.fn(); state.owner = 'B'
    await expect(resumePhoneAfterAccountClosure('A', commit)).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(state.resume).not.toHaveBeenCalled(); state.owner = 'A'
    state.resume.mockImplementationOnce(async () => { state.owner = 'B'; return { resumed: true } })
    await expect(resumePhoneAfterAccountClosure('A', commit)).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(commit).not.toHaveBeenCalled()
  })
  it('an older shell with no V2 custody capability retains its existing explicit enable behavior', async () => {
    const commit = vi.fn(); state.v2 = false
    await resumePhoneAfterAccountClosure('A', commit)
    expect(state.resume).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledOnce()
  })
})
