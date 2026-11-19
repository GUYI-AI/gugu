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
  it('does not confirm or cancel after a lost preparation response or invent its server generation', async () => {
    const f = fixture(); await f.flow.refresh()
    vi.mocked(f.native.prepare).mockImplementation(async () => { f.set({ ...f.get(), phase: 'local-prepared', recoveryOnly: true, pendingEffect: 'prepare_device', agentsPaused: true }); return f.get() })
    await expect(f.flow.confirm({ code: '123456', acknowledgeForfeit: true })).rejects.toMatchObject({ code: 'closure_not_prepared' })
    expect(f.native.confirm).not.toHaveBeenCalled()
    await expect(f.flow.cancel()).rejects.toMatchObject({ code: 'closure_recovery_required' })
    expect(f.native.cancel).not.toHaveBeenCalled()
    expect(f.flow.getState().operation?.serverPreparationGeneration).toBeNull()
    expect(f.flow.getState().operation?.agentsPaused).toBe(true)
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
  it('recovers an uncertain confirmation only through the original result', async () => {
    const f = fixture('processing'); f.set({ ...f.get(), recoveryOnly: true, pendingEffect: 'confirm' }); await f.flow.refresh()
    await expect(f.flow.confirm({ code: '123456', acknowledgeForfeit: true })).rejects.toMatchObject({ code: 'closure_recovery_required' })
    await expect(f.flow.cancel()).rejects.toMatchObject({ code: 'closure_recovery_required' })
    await f.flow.recover()
    expect(f.native.recover).toHaveBeenCalledWith(f.get().handle)
    expect(f.native.capture).not.toHaveBeenCalled(); expect(f.native.prepare).not.toHaveBeenCalled(); expect(f.native.confirm).not.toHaveBeenCalled()
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
