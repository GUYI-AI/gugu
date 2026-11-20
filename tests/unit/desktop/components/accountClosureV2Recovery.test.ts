import { beforeEach, describe, expect, it, vi } from 'vitest'

const test = vi.hoisted(() => ({
  changed: null as null | (() => void), order: [] as string[], native: {
    discover: vi.fn(), readPolicy: vi.fn(), capture: vi.fn(), sendCode: vi.fn(), prepare: vi.fn(),
    confirm: vi.fn(), recover: vi.fn(), cancel: vi.fn(), finalize: vi.fn(),
  }, finalizeOwner: vi.fn(), currentOwner: null as string | null, unlisten: vi.fn(),
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  accountClosureV2: test.native, subscribeAppForeground: () => () => {},
} }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({
  eventOn: (channel: string, callback: () => void) => {
    expect(channel).toBe('account-closure:v2-changed'); test.order.push('subscribe'); test.changed = callback; return test.unlisten
  },
}) }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ observeRendererSession: () => () => {} }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: {
  finalizeClosedOwner: test.finalizeOwner, getSnapshot: () => ({ session: test.currentOwner ? { user: { id: test.currentOwner } } : null }),
} }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/projects/stores/account-projects-cache', () => ({ forgetCachedAccountProjectsForOwner: vi.fn() }))
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: vi.fn() }))
vi.mock('../../../../apps/desktop/src/i18n', () => ({ i18n: { t: () => '账号已注销' } }))
vi.mock('../../../../apps/desktop/src/i18n/registerSettingsCatalog', () => ({}))

const id = '11111111-1111-4111-8111-111111111111'
const complete = {
  handle: { localOperationId: id, nativeGeneration: id, localRevision: 5 }, ownerId: id, phase: 'local-complete',
  serverOperation: { operationId: id, state: 'deleted', operationRevision: 7, challengeGeneration: 1 },
  serverPreparationGeneration: id, recoveryOnly: false, pendingEffect: null, agentsPaused: true, retainedUnattributed: [],
}
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); test.order = []; test.changed = null; test.currentOwner = null
  test.native.discover.mockImplementation(async () => { test.order.push('discover'); return complete })
  test.native.readPolicy.mockRejectedValue(Object.assign(new Error('Signed out'), { code: 'unauthorized' }))
  test.native.finalize.mockResolvedValue({ ...complete, phase: 'finalized' })
  test.finalizeOwner.mockResolvedValue(undefined)
})
describe('App-root V2 restoration', () => {
  it('subscribes then discovers an already-complete operation without needing a new event or live Auth', async () => {
    const { observeAccountClosureV2Recovery } = await import('../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureV2Runtime')
    const onError = vi.fn(), dispose = observeAccountClosureV2Recovery(onError)
    await vi.waitFor(() => expect(test.native.finalize).toHaveBeenCalledExactlyOnceWith(complete.handle))
    expect(test.order.slice(0, 2)).toEqual(['subscribe', 'discover'])
    expect(test.finalizeOwner).toHaveBeenCalledExactlyOnceWith(id)
    for (const method of ['capture', 'sendCode', 'prepare', 'confirm', 'recover', 'cancel'] as const) expect(test.native[method]).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled(); dispose(); expect(test.unlisten).toHaveBeenCalledOnce()
  })
  it('keeps the native capability when B prevents original-owner renderer finalization', async () => {
    test.currentOwner = 'B'; test.finalizeOwner.mockRejectedValue(Object.assign(new Error('B owns renderer'), { code: 'wrong_local_owner' }))
    const runtime = await import('../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureV2Runtime')
    const onError = vi.fn(), dispose = runtime.observeAccountClosureV2Recovery(onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(test.native.finalize).not.toHaveBeenCalled()
    expect(runtime.accountClosureV2Controller()?.getSnapshot().operation?.phase).toBe('local-complete')
    dispose()
  })
  it('treats a native event only as a result-read hint, never a deletion or cancellation ACK', async () => {
    const unknown = { ...complete, phase: 'confirming', pendingEffect: 'confirm', recoveryOnly: true,
      serverOperation: { ...complete.serverOperation, state: 'open' } }
    test.native.discover.mockResolvedValue(unknown); test.native.recover.mockResolvedValue(unknown)
    const runtime = await import('../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureV2Runtime')
    const dispose = runtime.observeAccountClosureV2Recovery(vi.fn())
    await vi.waitFor(() => expect(test.native.recover).toHaveBeenCalledOnce())
    test.changed?.()
    await vi.waitFor(() => expect(test.native.recover).toHaveBeenCalledTimes(2))
    for (const method of ['capture', 'sendCode', 'prepare', 'confirm', 'cancel', 'finalize'] as const) expect(test.native[method]).not.toHaveBeenCalled()
    expect(test.finalizeOwner).not.toHaveBeenCalled(); dispose()
  })
})
