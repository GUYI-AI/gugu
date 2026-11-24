import { describe, expect, it, vi } from 'vitest'
import { createAccountClosureV2Flow } from '../../../../apps/desktop/src/platform/accountClosureV2Flow'
import type { AccountClosureV2Native, AccountClosureV2Policy, AccountClosureV2Snapshot } from '../../../../apps/desktop/src/platform/accountClosureV2'
const policy: AccountClosureV2Policy = { protocol_version: 2, available: true, deletion: 'immediate', credit_treatment: 'forfeit_remaining', consent_version: 'immediate-forfeit-v1', device_preparation_required: true }
function fixture(phase: AccountClosureV2Snapshot['phase'] = 'registered') {
  let value: AccountClosureV2Snapshot | null = { handle: { localOperationId: 'original', nativeGeneration: 'native-original', localRevision: 4 }, ownerId: 'A', phase,
    serverOperation: { operationId: 'server-original', state: phase === 'local-complete' ? 'deleted' : 'open', operationRevision: 9, challengeGeneration: 1 },
    serverPreparationGeneration: phase === 'prepared' ? 'server-generation' : null, recoveryOnly: false, pendingEffect: null, agentsPaused: false, retainedUnattributed: [] }
  const same = async () => structuredClone(value!)
  const native: AccountClosureV2Native = { readPolicy: vi.fn(async () => policy), discover: vi.fn(async () => structuredClone(value)), capture: vi.fn(same), sendCode: vi.fn(same), prepare: vi.fn(same), confirm: vi.fn(same), recover: vi.fn(same), cancel: vi.fn(same), finalize: vi.fn(same) }
  const finalizeOwner = vi.fn(async (_owner: string) => {})
  return { native, finalizeOwner, flow: createAccountClosureV2Flow({ native, finalizeOwner }), set: (next: AccountClosureV2Snapshot | null) => { value = next }, get: () => structuredClone(value!) }
}
describe('shared V2 execution sequence', () => {
  it('does not publish arbitrary transport details as an error category', async () => {
    const f = fixture(); vi.mocked(f.native.readPolicy).mockRejectedValue({ code: 'a'.repeat(64) })
    await f.flow.refresh()
    expect(f.flow.getState().policy).toEqual({ status: 'failed', code: 'closure_unavailable' })
    expect(JSON.stringify(f.flow.getState())).not.toContain('a'.repeat(64))
  })
  it('keeps original recovery when policy fails after Auth disappears, without manufacturing admission', async () => {
    const f = fixture('processing'); vi.mocked(f.native.readPolicy).mockRejectedValue({ code: 'unauthorized' })
    await f.flow.refresh()
    expect(f.flow.getState().policy).toEqual({ status: 'failed', code: 'unauthorized' })
    await f.flow.recover()
    expect(f.native.recover).toHaveBeenCalledWith(f.get().handle)
    expect(f.native.capture).not.toHaveBeenCalled(); expect(f.native.confirm).not.toHaveBeenCalled()
    await expect(f.flow.sendCode()).rejects.toMatchObject({ code: 'closure_unavailable' })
  })
  it('does not confirm or invent a generation after lost preparation; native alone decides cancellation', async () => {
    const f = fixture(); await f.flow.refresh()
    vi.mocked(f.native.prepare).mockImplementation(async () => { f.set({ ...f.get(), phase: 'local-prepared', recoveryOnly: true, pendingEffect: 'prepare_device', agentsPaused: true }); return f.get() })
    await expect(f.flow.confirm({ code: '123456', acknowledgeForfeit: true })).rejects.toMatchObject({ code: 'closure_not_prepared' })
    expect(f.native.confirm).not.toHaveBeenCalled()
    await f.flow.cancel()
    expect(f.native.cancel).toHaveBeenCalledWith(f.get().handle)
    expect(f.flow.getState().operation?.phase).toBe('local-prepared')
    expect(f.flow.getState().operation?.serverPreparationGeneration).toBeNull()
    expect(f.flow.getState().operation?.agentsPaused).toBe(true)
  })
  it('allows explicit native tombstone cancellation of uncertain registration without re-registering', async () => {
    const f = fixture('captured'); f.set({ ...f.get(), serverOperation: null, recoveryOnly: true, pendingEffect: 'register' }); await f.flow.refresh()
    await f.flow.cancel()
    expect(f.native.cancel).toHaveBeenCalledWith(f.get().handle)
    expect(f.native.capture).not.toHaveBeenCalled(); expect(f.native.sendCode).not.toHaveBeenCalled()
    expect(f.flow.getState().operation?.phase).toBe('captured')
  })
  it('refuses parallel confirmation rather than queueing a second destructive command', async () => {
    const f = fixture('prepared'); await f.flow.refresh()
    const gate = Promise.withResolvers<AccountClosureV2Snapshot>()
    vi.mocked(f.native.confirm).mockReturnValue(gate.promise)
    const first = f.flow.confirm({ code: '123456', acknowledgeForfeit: true })
    await expect(f.flow.confirm({ code: '123456', acknowledgeForfeit: true })).rejects.toMatchObject({ code: 'closure_busy' })
    gate.resolve(f.get()); await first
    expect(f.native.confirm).toHaveBeenCalledTimes(1)
    expect(f.flow.getState().busy).toBe(false)
  })
  it('does not cancel known processing or replay a confirmation', async () => {
    const f = fixture('processing'); f.set({ ...f.get(), recoveryOnly: true, pendingEffect: 'confirm' }); await f.flow.refresh()
    await expect(f.flow.confirm({ code: '123456', acknowledgeForfeit: true })).rejects.toMatchObject({ code: 'closure_recovery_required' })
    await expect(f.flow.cancel()).rejects.toMatchObject({ code: 'closure_recovery_required' })
    await f.flow.recover()
    expect(f.native.recover).toHaveBeenCalledWith(f.get().handle)
    expect(f.native.capture).not.toHaveBeenCalled(); expect(f.native.prepare).not.toHaveBeenCalled(); expect(f.native.confirm).not.toHaveBeenCalled()
  })
  it('allows the existing explicit cancel intent while confirmation outcome is unknown', async () => {
    const f = fixture('confirming')
    f.set({ ...f.get(), recoveryOnly: true, pendingEffect: 'confirm' }); await f.flow.refresh()
    vi.mocked(f.native.cancel).mockImplementation(async () => {
      f.set({ ...f.get(), phase: 'cancelled', pendingEffect: null, recoveryOnly: false, agentsPaused: true })
      return f.get()
    })
    const state = await f.flow.cancel()
    expect(state.operation?.phase).toBe('cancelled'); expect(state.operation?.agentsPaused).toBe(true)
    expect(f.native.cancel).toHaveBeenCalledTimes(1)
    expect(f.native.confirm).not.toHaveBeenCalled()
  })
  it('waits for original result after cancellation is rejected as request_active', async () => {
    const f = fixture('confirming')
    f.set({ ...f.get(), recoveryOnly: true, pendingEffect: 'confirm' }); await f.flow.refresh()
    vi.mocked(f.native.cancel).mockImplementation(async () => {
      f.set({ ...f.get(), confirmCancellationBlocked: true })
      throw Object.assign(new Error('request_active'), { code: 'request_active' })
    })
    await expect(f.flow.cancel()).rejects.toMatchObject({ code: 'request_active' })
    await expect(f.flow.cancel()).rejects.toMatchObject({ code: 'closure_recovery_required' })
    await f.flow.recover()
    expect(f.native.cancel).toHaveBeenCalledTimes(1); expect(f.native.recover).toHaveBeenCalledTimes(1)
    expect(f.native.confirm).not.toHaveBeenCalled()
    expect(f.flow.getState().operation).toMatchObject({ pendingEffect: 'confirm', confirmCancellationBlocked: true })
  })
  it('never loops a failed cancel but permits another explicit click on the same intent', async () => {
    const f = fixture('confirming')
    f.set({ ...f.get(), recoveryOnly: true, pendingEffect: 'confirm' }); await f.flow.refresh()
    vi.mocked(f.native.cancel).mockRejectedValueOnce({ code: 'closure_unavailable' })
    await expect(f.flow.cancel()).rejects.toMatchObject({ code: 'closure_unavailable' })
    expect(f.native.cancel).toHaveBeenCalledTimes(1)
    await f.flow.cancel()
    expect(f.native.cancel).toHaveBeenCalledTimes(2)
    expect(vi.mocked(f.native.cancel).mock.calls[0]).toEqual(vi.mocked(f.native.cancel).mock.calls[1])
    expect(f.native.confirm).not.toHaveBeenCalled()
  })
  it('does not finalize processing or erase another renderer account', async () => {
    const f = fixture('processing'); await f.flow.refresh()
    await expect(f.flow.finalize()).rejects.toMatchObject({ code: 'closure_not_complete' })
    expect(f.finalizeOwner).not.toHaveBeenCalled()
    f.set({ ...f.get(), phase: 'local-complete', serverOperation: { ...f.get().serverOperation!, state: 'deleted' } }); await f.flow.refresh()
    f.finalizeOwner.mockRejectedValue({ code: 'wrong_local_owner' })
    await expect(f.flow.finalize()).rejects.toMatchObject({ code: 'wrong_local_owner' })
    expect(f.finalizeOwner).toHaveBeenCalledWith('A'); expect(f.native.finalize).not.toHaveBeenCalled()
    expect(f.flow.getState().operation?.phase).toBe('local-complete')
  })
  it('retains completion custody until renderer finalization succeeds and returns an idle final state', async () => {
    const f = fixture('local-complete'); await f.flow.refresh()
    vi.mocked(f.native.finalize).mockImplementation(async () => { f.set({ ...f.get(), phase: 'finalized' }); return f.get() })
    const state = await f.flow.finalize()
    expect(f.finalizeOwner).toHaveBeenCalledWith('A'); expect(state.operation?.phase).toBe('finalized'); expect(state.busy).toBe(false)
  })
})
