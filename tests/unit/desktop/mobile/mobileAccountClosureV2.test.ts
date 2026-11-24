import { describe, expect, it, vi } from 'vitest'
import { mobileAccountClosureV2, type MobileAccountClosureV2Bridge } from '../../../../apps/desktop/src/platform/mobileAccountClosureV2'
import type { AccountClosureV2Snapshot } from '../../../../apps/desktop/src/platform/accountClosureV2'

const uuid = '11111111-1111-4111-8111-111111111111'
const handle = { localOperationId: uuid, nativeGeneration: uuid, localRevision: 3 }
const snapshot: AccountClosureV2Snapshot = {
  handle, ownerId: uuid, phase: 'confirming', serverOperation: { operationId: uuid, state: 'open', operationRevision: 1, challengeGeneration: 1 },
  serverPreparationGeneration: uuid, recoveryOnly: true, pendingEffect: 'confirm', agentsPaused: true, retainedUnattributed: [],
}
const policy = { protocol_version: 2, available: false, deletion: 'immediate', credit_treatment: 'forfeit_remaining',
  consent_version: 'immediate-forfeit-v1', device_preparation_required: true }
function setup() {
  const bridge: MobileAccountClosureV2Bridge = {
    readPolicy: vi.fn(async () => policy), discover: vi.fn(async () => ({ snapshot })), capture: vi.fn(async () => snapshot),
    sendCode: vi.fn(async () => snapshot), prepare: vi.fn(async () => snapshot), confirm: vi.fn(async () => snapshot),
    recover: vi.fn(async () => snapshot), cancel: vi.fn(async () => snapshot), finalizeOperation: vi.fn(async () => snapshot),
  }
  return { bridge, facade: mobileAccountClosureV2(bridge) }
}
describe('phone independent V2 native facade', () => {
  it('preserves a successful closed policy and rejects dependency failures without a false policy fallback', async () => {
    const f = setup(); await expect(f.facade.readPolicy()).resolves.toEqual(policy)
    const unavailable = Object.assign(new Error('Unavailable'), { code: 'unavailable' })
    vi.mocked(f.bridge.readPolicy).mockRejectedValue(unavailable)
    await expect(f.facade.readPolicy()).rejects.toBe(unavailable)
    expect(f.bridge.capture).not.toHaveBeenCalled()
  })
  it('discovers original pending metadata and distinguishes no operation from missing acknowledgements', async () => {
    const f = setup(); await expect(f.facade.discover()).resolves.toEqual(snapshot)
    vi.mocked(f.bridge.discover).mockResolvedValue({ snapshot: null })
    await expect(f.facade.discover()).resolves.toBeNull()
    vi.mocked(f.bridge.discover).mockResolvedValue({})
    await expect(f.facade.discover()).rejects.toMatchObject({ code: 'closure_unavailable' })
  })
  it('recovery dispatches only original result and never turns open into a new confirmation', async () => {
    const f = setup(); const result = await f.facade.recover(handle)
    expect(result.pendingEffect).toBe('confirm'); expect(result.recoveryOnly).toBe(true)
    expect(f.bridge.recover).toHaveBeenCalledExactlyOnceWith({ handle })
    for (const name of ['capture', 'sendCode', 'prepare', 'confirm', 'cancel'] as const) expect(f.bridge[name]).not.toHaveBeenCalled()
  })
  it('passes only a native boolean cancellation fence, preserving the original confirm intent', async () => {
    const f = setup()
    vi.mocked(f.bridge.recover).mockResolvedValue({ ...snapshot, confirmCancellationBlocked: true })
    await expect(f.facade.recover(handle)).resolves.toMatchObject({ pendingEffect: 'confirm', confirmCancellationBlocked: true })
    vi.mocked(f.bridge.recover).mockResolvedValue({ ...snapshot, confirmCancellationBlocked: 'false' })
    await expect(f.facade.recover(handle)).rejects.toMatchObject({ code: 'closure_unavailable' })
    expect(f.bridge.cancel).not.toHaveBeenCalled()
  })
  it('allows only code and explicit consent as confirmation input', async () => {
    const f = setup(); await f.facade.confirm(handle, { code: '123456', acknowledgeForfeit: true })
    expect(f.bridge.confirm).toHaveBeenCalledExactlyOnceWith({ handle, code: '123456', acknowledgeForfeit: true })
    for (const input of [
      { code: '123456', acknowledgeForfeit: false }, { code: 'not-a-code', acknowledgeForfeit: true },
      { code: '123456', acknowledgeForfeit: true, confirmationId: uuid },
      { code: '123456', acknowledgeForfeit: true, receipt: 'must-not-reach-native' },
    ]) await expect(f.facade.confirm(handle, input as never)).rejects.toMatchObject({ code: 'closure_unavailable' })
    expect(f.bridge.confirm).toHaveBeenCalledTimes(1)
  })
  it('refuses stale or forged handle representations before a native call', async () => {
    const f = setup()
    for (const h of [{ ...handle, localRevision: 0 }, { ...handle, localRevision: 1.2 },
      { ...handle, localRevision: Number.MAX_SAFE_INTEGER + 1 }, { ...handle, nativeGeneration: 'renderer-generation' },
      { ...handle, ownerId: uuid }, { ...handle, serverGeneration: uuid },
    ]) await expect(f.facade.cancel(h)).rejects.toMatchObject({ code: 'closure_unavailable' })
    expect(f.bridge.cancel).not.toHaveBeenCalled()
  })
  it('rejects secrets and unrecognized terminal facts rather than passing raw objects to renderer', async () => {
    const f = setup()
    for (const value of [{ ...snapshot, receipt: 'secret' }, { ...snapshot, originalAuthSessionId: uuid },
      { ...snapshot, phase: 'success' }, { ...snapshot, serverOperation: { ...snapshot.serverOperation, state: 'unknown-success' } },
      { ...snapshot, retainedUnattributed: ['/private/path'] }, { ...snapshot, serverPreparationGeneration: true },
    ]) {
      vi.mocked(f.bridge.capture).mockResolvedValue(value)
      await expect(f.facade.capture()).rejects.toMatchObject({ code: 'closure_unavailable' })
    }
  })
  it('keeps native failures and cancellation pending visible without calling legacy receipt erasure', async () => {
    const f = setup(); const cancelled = { ...snapshot, phase: 'cancel-pending', pendingEffect: 'cancel' }
    vi.mocked(f.bridge.cancel).mockResolvedValue(cancelled)
    await expect(f.facade.cancel(handle)).resolves.toEqual(cancelled)
    vi.mocked(f.bridge.finalizeOperation).mockRejectedValue(Object.assign(new Error('Refused'), { code: 'scope_conflict' }))
    await expect(f.facade.finalize(handle)).rejects.toMatchObject({ code: 'scope_conflict' })
    expect(f.bridge.finalizeOperation).toHaveBeenCalledExactlyOnceWith({ handle })
    expect(f.bridge.recover).not.toHaveBeenCalled()
  })
})
