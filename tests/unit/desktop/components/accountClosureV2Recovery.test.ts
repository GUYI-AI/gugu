import { beforeEach, describe, expect, it, vi } from 'vitest'
import { registerAccountClosedNoticeIpc } from '../../../../apps/desktop/electron/account-closure/v2-ipc'

const test = vi.hoisted(() => ({
  changed: null as null | (() => void), order: [] as string[], native: {
    discover: vi.fn(), readPolicy: vi.fn(), capture: vi.fn(), sendCode: vi.fn(), prepare: vi.fn(),
    confirm: vi.fn(), recover: vi.fn(), cancel: vi.fn(), finalize: vi.fn(),
  }, finalizeOwner: vi.fn(), currentOwner: null as string | null, unlisten: vi.fn(),
  appRelaunch: false, relaunch: vi.fn(), logout: vi.fn(), forgetAll: vi.fn(), notify: vi.fn(),
  // Main's app-state.json across the relaunch, and its real notice handler.
  appState: {} as Record<string, unknown>, main: null as null | ((event: unknown, input: unknown) => unknown), mainEvent: null as unknown,
}))
vi.mock('../../../../apps/desktop/src/platform', () => ({ platform: {
  accountClosureV2: test.native, subscribeAppForeground: () => () => {},
  capabilities: { get appRelaunch() { return test.appRelaunch } }, relaunchApp: test.relaunch,
} }))
vi.mock('../../../../apps/desktop/src/platform/desktopIpc', () => ({ desktopIpc: () => ({
  eventOn: (channel: string, callback: () => void) => {
    expect(channel).toBe('account-closure:v2-changed'); test.order.push('subscribe'); test.changed = callback; return test.unlisten
  },
  invoke: async (channel: string, input: { type: string }) => {
    expect(channel).toBe('account-closure:closed-notice'); test.order.push(`notice:${input.type}`)
    return test.main!(test.mainEvent, input)
  },
}) }))
vi.mock('../../../../apps/desktop/src/lib/sessionPublication', () => ({ observeRendererSession: () => () => {} }))
vi.mock('../../../../apps/desktop/src/lib/sessionCoordinator', () => ({ sessionCoordinator: {
  finalizeClosedOwner: test.finalizeOwner, logout: test.logout,
  getSnapshot: () => ({ session: test.currentOwner ? { user: { id: test.currentOwner } } : null }),
} }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/projects/stores/account-projects-cache', () => ({
  forgetCachedAccountProjectsForOwner: vi.fn(), forgetCachedAccountProjects: test.forgetAll,
}))
vi.mock('../../../../apps/desktop/src/lib/authLogout', async importOriginal => {
  const actual = await importOriginal<typeof import('../../../../apps/desktop/src/lib/authLogout')>()
  return { ...actual, finishSignedOut: vi.fn(actual.finishSignedOut) }
})
vi.mock('../../../../apps/desktop/src/lib/notices', () => ({ notify: test.notify }))
vi.mock('../../../../apps/desktop/src/i18n', () => ({ i18n: { t: () => '账号已注销' } }))
vi.mock('../../../../apps/desktop/src/i18n/registerSettingsCatalog', () => ({}))

const id = '11111111-1111-4111-8111-111111111111'
const complete = {
  handle: { localOperationId: id, nativeGeneration: id, localRevision: 5 }, ownerId: id, phase: 'local-complete',
  serverOperation: { operationId: id, state: 'deleted', operationRevision: 7, challengeGeneration: 1 },
  serverPreparationGeneration: id, recoveryOnly: false, pendingEffect: null, agentsPaused: true, retainedUnattributed: [],
}
const closedNotice = { key: 'account-closed', tier: 'success', title: '账号已注销' }
const runtime = () => import('../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureV2Runtime')
const sharedTail = async () => vi.mocked((await import('../../../../apps/desktop/src/lib/authLogout')).finishSignedOut)
beforeEach(() => {
  vi.resetModules(); vi.clearAllMocks(); test.order = []; test.changed = null; test.currentOwner = null
  test.appRelaunch = false; test.appState = {}
  test.native.discover.mockImplementation(async () => { test.order.push('discover'); return complete })
  test.native.readPolicy.mockRejectedValue(Object.assign(new Error('Signed out'), { code: 'unauthorized' }))
  test.native.finalize.mockImplementation(async () => { test.order.push('native-finalize'); return { ...complete, phase: 'finalized' } })
  test.finalizeOwner.mockResolvedValue(undefined)
  test.relaunch.mockImplementation(async () => { test.order.push('relaunch') })
  const frame = {}, sender = { mainFrame: frame }, window = { isDestroyed: () => false, webContents: sender }
  test.mainEvent = { sender, senderFrame: frame }
  registerAccountClosedNoticeIpc({ handle: (_channel: string, fn: unknown) => { test.main = fn as typeof test.main } } as never, () => window as never,
    { read: () => structuredClone(test.appState), write: next => { test.appState = structuredClone(next) } })
})
describe('App-root V2 restoration', () => {
  it('subscribes then discovers an already-complete operation without needing a new event or live Auth', async () => {
    const { observeAccountClosureV2Recovery } = await runtime()
    const onError = vi.fn(), dispose = observeAccountClosureV2Recovery(onError)
    await vi.waitFor(() => expect(test.native.finalize).toHaveBeenCalledExactlyOnceWith(complete.handle))
    expect(test.order.slice(0, 2)).toEqual(['subscribe', 'discover'])
    expect(test.finalizeOwner).toHaveBeenCalledExactlyOnceWith(id)
    for (const method of ['capture', 'sendCode', 'prepare', 'confirm', 'recover', 'cancel'] as const) expect(test.native[method]).not.toHaveBeenCalled()
    expect(onError).not.toHaveBeenCalled(); dispose(); expect(test.unlisten).toHaveBeenCalledOnce()
  })
  it('keeps the native capability when B prevents original-owner renderer finalization', async () => {
    test.currentOwner = 'B'; test.finalizeOwner.mockRejectedValue(Object.assign(new Error('B owns renderer'), { code: 'wrong_local_owner' }))
    const current = await runtime()
    const onError = vi.fn(), dispose = current.observeAccountClosureV2Recovery(onError)
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce())
    expect(test.native.finalize).not.toHaveBeenCalled()
    expect(current.accountClosureV2Controller()?.getSnapshot().operation?.phase).toBe('local-complete')
    expect(await sharedTail()).not.toHaveBeenCalled(); expect(test.relaunch).not.toHaveBeenCalled()
    dispose()
  })
  it('treats a native event only as a result-read hint, never a deletion or cancellation ACK', async () => {
    const unknown = { ...complete, phase: 'confirming', pendingEffect: 'confirm', recoveryOnly: true,
      serverOperation: { ...complete.serverOperation, state: 'open' } }
    test.native.discover.mockResolvedValue(unknown); test.native.recover.mockResolvedValue(unknown)
    const current = await runtime()
    const dispose = current.observeAccountClosureV2Recovery(vi.fn())
    await vi.waitFor(() => expect(test.native.recover).toHaveBeenCalledOnce())
    test.changed?.()
    await vi.waitFor(() => expect(test.native.recover).toHaveBeenCalledTimes(2))
    for (const method of ['capture', 'sendCode', 'prepare', 'confirm', 'cancel', 'finalize'] as const) expect(test.native[method]).not.toHaveBeenCalled()
    expect(test.finalizeOwner).not.toHaveBeenCalled(); expect(test.relaunch).not.toHaveBeenCalled(); dispose()
  })
})
describe('after a finalized closure (#3446)', () => {
  it('restarts through the shared sign-out tail only after native finalize, never via a live sign-out', async () => {
    test.appRelaunch = true
    const dispose = (await runtime()).observeAccountClosureV2Recovery(vi.fn())
    await vi.waitFor(() => expect(test.relaunch).toHaveBeenCalledOnce())
    expect(await sharedTail()).toHaveBeenCalledOnce()
    expect(test.order.slice(test.order.indexOf('native-finalize'))).toEqual(['native-finalize', 'notice:mark', 'relaunch'])
    expect(test.forgetAll).toHaveBeenCalledOnce(); expect(test.logout).not.toHaveBeenCalled()
    // This renderer is about to be replaced; the notice belongs to the next boot.
    expect(test.notify).not.toHaveBeenCalled(); expect(test.appState).toEqual({ accountClosedNotice: true })
    dispose()
  })
  it('shows the marker once on the first boot after the restart, then never again', async () => {
    test.appState = { windowTone: 'dark', accountClosedNotice: true }
    const firstBoot = await runtime()
    firstBoot.announceAccountClosedAfterRelaunch(); firstBoot.announceAccountClosedAfterRelaunch()
    await vi.waitFor(() => expect(test.notify).toHaveBeenCalledExactlyOnceWith(closedNotice))
    expect(test.appState).toEqual({ windowTone: 'dark' })
    expect(test.order.filter(step => step === 'notice:take')).toHaveLength(1)
    vi.resetModules(); test.notify.mockClear()
    ;(await runtime()).announceAccountClosedAfterRelaunch()
    await vi.waitFor(() => expect(test.order.filter(step => step === 'notice:take')).toHaveLength(2))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.notify).not.toHaveBeenCalled()
  })
  it('a signed-in boot clears a stale marker without showing it', async () => {
    test.appState = { accountClosedNotice: true }; test.currentOwner = 'B'
    ;(await runtime()).announceAccountClosedAfterRelaunch()
    await vi.waitFor(() => expect(test.appState).toEqual({}))
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(test.notify).not.toHaveBeenCalled()
  })
  it('without restart support, shows the notice directly and requests no restart or marker', async () => {
    const dispose = (await runtime()).observeAccountClosureV2Recovery(vi.fn())
    await vi.waitFor(() => expect(test.notify).toHaveBeenCalledExactlyOnceWith(closedNotice))
    expect(await sharedTail()).toHaveBeenCalledOnce(); expect(test.forgetAll).toHaveBeenCalledOnce()
    expect(test.relaunch).not.toHaveBeenCalled(); expect(test.logout).not.toHaveBeenCalled()
    expect(test.order.some(step => step.startsWith('notice:'))).toBe(false); expect(test.appState).toEqual({})
    dispose()
  })
  it('a refused restart shows the notice in place and leaves no marker for a later boot', async () => {
    test.appRelaunch = true; test.relaunch.mockRejectedValueOnce(Object.assign(new Error('no relaunch'), { code: 'unavailable' }))
    const dispose = (await runtime()).observeAccountClosureV2Recovery(vi.fn())
    await vi.waitFor(() => expect(test.notify).toHaveBeenCalledExactlyOnceWith(closedNotice))
    expect(test.appState).toEqual({}); dispose()
  })
})
