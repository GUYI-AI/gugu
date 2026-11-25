import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({ owner: 'A', v2: true, self: vi.fn(), resume: vi.fn() }))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  kind: 'electron', get accountClosureV2() { return state.v2 ? {} : undefined },
  getLocalDeviceSelfSnapshot: state.self, resumeAgentsAfterAccountClosure: state.resume,
} }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ getRendererSession: () => ({ user: { id: state.owner } }) }))
import { commitManualAgentDesiredStatus } from '../../../../apps/desktop/src/lib/manualAgentDesiredStatus'

const agent = { owner_user_id: 'A', device_id: 'local', desired_status: 'offline' as const }
beforeEach(() => {
  state.owner = 'A'; state.v2 = true
  state.self.mockReset().mockResolvedValue({ device_id: 'local' })
  state.resume.mockReset().mockResolvedValue(undefined)
})

describe('explicit desktop agent resume after account closure', () => {
  it('binds the original click owner and waits for native before publishing online', async () => {
    const order: string[] = []
    state.resume.mockImplementation(async owner => { order.push('resume:' + owner) })
    const commit = vi.fn(async () => { order.push('online') })
    await commitManualAgentDesiredStatus(agent, 'online', commit)
    expect(order).toEqual(['resume:A', 'online'])
    expect(state.resume).toHaveBeenCalledExactlyOnceWith('A')
    expect(commit).toHaveBeenCalledOnce()
  })
  it('does not publish online when original native custody still refuses release', async () => {
    const commit = vi.fn()
    state.resume.mockRejectedValueOnce(Object.assign(new Error('Pending'), { code: 'closure_recovery_required' }))
    await expect(commitManualAgentDesiredStatus(agent, 'online', commit)).rejects.toMatchObject({ code: 'closure_recovery_required' })
    expect(commit).not.toHaveBeenCalled()
  })
  it('rejects A-to-B while identifying the local device before asking native to resume', async () => {
    const commit = vi.fn()
    state.self.mockImplementationOnce(async () => { state.owner = 'B'; return { device_id: 'local' } })
    await expect(commitManualAgentDesiredStatus(agent, 'online', commit)).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(state.resume).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
  })
  it('rejects a stale A control when B already owns the renderer at the click', async () => {
    const commit = vi.fn(); state.owner = 'B'
    await expect(commitManualAgentDesiredStatus(agent, 'online', commit)).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(state.self).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
  })
  it('rejects A-to-B after the native acknowledgement without publishing the stale intent', async () => {
    const commit = vi.fn()
    state.resume.mockImplementationOnce(async () => { state.owner = 'B' })
    await expect(commitManualAgentDesiredStatus(agent, 'online', commit)).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(state.resume).toHaveBeenCalledExactlyOnceWith('A'); expect(commit).not.toHaveBeenCalled()
  })
  it('does not infer a remote host from a missing local identity', async () => {
    const commit = vi.fn(); state.self.mockResolvedValueOnce(null)
    await expect(commitManualAgentDesiredStatus(agent, 'online', commit)).rejects.toMatchObject({ name: 'LocalDeviceUnidentifiedError' })
    expect(state.resume).not.toHaveBeenCalled(); expect(commit).not.toHaveBeenCalled()
  })
  it('leaves a verified remote agent on its existing contacts path', async () => {
    const commit = vi.fn()
    await commitManualAgentDesiredStatus({ ...agent, device_id: 'remote' }, 'online', commit)
    expect(state.resume).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledOnce()
  })
  it('never invokes native resume for a pause action', async () => {
    const commit = vi.fn()
    await commitManualAgentDesiredStatus({ ...agent, desired_status: 'online' }, 'offline', commit)
    expect(state.self).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledOnce()
  })
  it('preserves ordinary controls on an older desktop without V2 custody', async () => {
    const commit = vi.fn(); state.v2 = false
    await commitManualAgentDesiredStatus(agent, 'online', commit)
    expect(state.self).not.toHaveBeenCalled(); expect(state.resume).not.toHaveBeenCalled(); expect(commit).toHaveBeenCalledOnce()
  })
})
