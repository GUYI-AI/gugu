import { createAccountClosureLocalCleanup } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureLocalCleanup'
import type { PhoneAccountClosureActions } from '../../../../apps/desktop/src/components/settings/accountDeletion/phoneAccountClosureFlow'
const createPhoneAccountClosureFlow = (actions: Omit<PhoneAccountClosureActions, 'localCleanup' | 'readResult'>) => createFlow({ ...actions, readResult: async () => ({ status: 'processing' }), localCleanup: createAccountClosureLocalCleanup({
  scope: { ownerId: 'owner', localOperationId: 'operation' }, native: { receipt: { put: async () => {}, get: async () => 'opaque-test-proof', remove: async () => {} }, eraseLocal: async () => ({ status: 'complete', retainedUnattributed: [] }) },
  journal: { write: async () => {}, read: async () => null, remove: async () => {} },
}) })
import { describe, expect, it, vi } from 'vitest'
import { createPhoneAccountClosureFlow as createFlow, type PhoneCleanupAcknowledgement, type PhoneCloseAcknowledgement } from '../../../../apps/desktop/src/components/settings/accountDeletion/phoneAccountClosureFlow'

function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done }); return { promise, resolve } }
const confirmed = { confirmed: true } as const
const closed = { status: 'deleted' } as const

for (const platform of ['android', 'ios'] as const) describe(`${platform} account closure order`, () => {
  it('waits for each explicit success and ignores duplicate confirmation', async () => {
    const stop = deferred<PhoneCleanupAcknowledgement>(), remove = deferred<PhoneCleanupAcknowledgement>(), close = deferred<PhoneCloseAcknowledgement>()
    const actions = { platform, stopAgent: vi.fn(() => stop.promise), removeDevice: vi.fn(() => remove.promise), closeAccount: vi.fn(() => close.promise) }
    const flow = createPhoneAccountClosureFlow(actions)
    const work = flow.start(); void flow.start()
    expect(actions.stopAgent).toHaveBeenCalledTimes(1)
    expect(actions.removeDevice).not.toHaveBeenCalled()
    expect(actions.closeAccount).not.toHaveBeenCalled()
    stop.resolve(confirmed); await Promise.resolve()
    expect(actions.removeDevice).toHaveBeenCalledTimes(1)
    expect(actions.closeAccount).not.toHaveBeenCalled()
    remove.resolve(confirmed); await Promise.resolve()
    expect(actions.closeAccount).toHaveBeenCalledTimes(1)
    expect(flow.getSnapshot()).toEqual({ status: 'running', phase: 'close-account' })
    close.resolve(closed); await work
    expect(flow.getSnapshot()).toEqual({ status: 'closed' })
  })

  it.each(['stop-agent', 'remove-device'] as const)('halts at failed %s and retries only that step', async phase => {
    const stopAgent = vi.fn(async (): Promise<PhoneCleanupAcknowledgement> => confirmed)
    const removeDevice = vi.fn(async (): Promise<PhoneCleanupAcknowledgement> => confirmed)
    const closeAccount = vi.fn(async () => closed)
    const failed = phase === 'stop-agent' ? stopAgent : removeDevice
    failed.mockResolvedValueOnce({ confirmed: false, canRetry: true })
    const flow = createPhoneAccountClosureFlow({ platform, stopAgent, removeDevice, closeAccount })
    await flow.start()
    expect(flow.getSnapshot()).toEqual({ status: 'failed', phase, canRetry: true })
    expect(closeAccount).not.toHaveBeenCalled()
    if (phase === 'stop-agent') expect(removeDevice).not.toHaveBeenCalled()
    await flow.retry()
    expect(stopAgent).toHaveBeenCalledTimes(phase === 'stop-agent' ? 2 : 1)
    expect(removeDevice).toHaveBeenCalledTimes(phase === 'remove-device' ? 2 : 1)
    expect(closeAccount).toHaveBeenCalledTimes(1)
    expect(flow.getSnapshot()).toEqual({ status: 'closed' })
  })

  it('does not advance for a malformed cleanup acknowledgement or an exception', async () => {
    const removeDevice = vi.fn(async () => confirmed), closeAccount = vi.fn(async () => closed)
    const flow = createPhoneAccountClosureFlow({ platform, stopAgent: vi.fn(async () => undefined as unknown as PhoneCleanupAcknowledgement), removeDevice, closeAccount })
    await flow.start(); await flow.retry()
    expect(flow.getSnapshot()).toEqual({ status: 'failed', phase: 'stop-agent', canRetry: false })
    expect(removeDevice).not.toHaveBeenCalled(); expect(closeAccount).not.toHaveBeenCalled()
    const other = createPhoneAccountClosureFlow({ platform, stopAgent: async () => { throw new Error('private adapter detail') }, removeDevice, closeAccount })
    await other.start()
    expect(other.getSnapshot()).toEqual({ status: 'failed', phase: 'stop-agent', canRetry: false })
    expect(JSON.stringify(other.getSnapshot())).not.toContain('private adapter detail')
  })

  it.each(['processing', 'lost'] as const)('keeps an unconfirmed %s response separate from success and never repeats the close call', async result => {
    const closeAccount = vi.fn(async (): Promise<PhoneCloseAcknowledgement> => { if (result === 'lost') throw new Error('offline'); return { status: 'processing' } })
    const flow = createPhoneAccountClosureFlow({ platform, stopAgent: async () => confirmed, removeDevice: async () => confirmed, closeAccount })
    await flow.start(); await flow.retry(); await flow.start()
    expect(flow.getSnapshot()).toEqual({ status: 'unconfirmed', phase: 'close-account' })
    expect(closeAccount).toHaveBeenCalledTimes(1)
  })

  it('repeats a rejected final call only when the adapter explicitly allows it', async () => {
    const closeAccount = vi.fn(async (): Promise<PhoneCloseAcknowledgement> => closed)
    closeAccount.mockResolvedValueOnce({ status: 'retry_wait', canRetry: true })
    const stopAgent = vi.fn(async () => confirmed), removeDevice = vi.fn(async () => confirmed)
    const flow = createPhoneAccountClosureFlow({ platform, stopAgent, removeDevice, closeAccount })
    await flow.start(); expect(flow.getSnapshot()).toEqual({ status: 'failed', phase: 'close-account', canRetry: true })
    await flow.retry()
    expect(stopAgent).toHaveBeenCalledTimes(1); expect(removeDevice).toHaveBeenCalledTimes(1); expect(closeAccount).toHaveBeenCalledTimes(2)
  })

  it('never reaches the next action after its component leaves', async () => {
    const stop = deferred<PhoneCleanupAcknowledgement>(), removeDevice = vi.fn(async () => confirmed), closeAccount = vi.fn(async () => closed)
    const flow = createPhoneAccountClosureFlow({ platform, stopAgent: () => stop.promise, removeDevice, closeAccount })
    const work = flow.start(); flow.cancel(); stop.resolve(confirmed); await work
    expect(removeDevice).not.toHaveBeenCalled(); expect(closeAccount).not.toHaveBeenCalled()
  })
})

for (const platform of ['android','ios'] as const) it(`${platform}: deleted keeps the receipt through pending local erase and removes it after complete`, async()=>{
  vi.useFakeTimers()
  try {
    let proof:string|null='opaque-proof'
    const eraseLocal=vi.fn(async()=>({status:'complete' as 'complete'|'pending',retainedUnattributed:[]}))
    eraseLocal.mockResolvedValueOnce({status:'pending',retainedUnattributed:[]})
    const remove=vi.fn(async()=>{proof=null})
    const native={receipt:{put:async()=>{},get:async()=>proof,remove},eraseLocal}
    const cleanup=createAccountClosureLocalCleanup({scope:{ownerId:'owner',localOperationId:'stable'},native,journal:{write:async()=>{},read:async()=>null,remove:async()=>{}}})
    const closeAccount=vi.fn(async()=>({status:'deleted' as const}))
    const flow=createFlow({platform,stopAgent:async()=>({confirmed:true}),removeDevice:async()=>({confirmed:true}),closeAccount,readResult:async()=>({status:'processing'}),localCleanup:cleanup})
    const work=flow.start();await vi.advanceTimersByTimeAsync(0)
    expect(flow.getSnapshot()).toEqual({status:'running',phase:'erase-local'});expect(proof).toBe('opaque-proof');expect(remove).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2000);await work
    expect(flow.getSnapshot()).toEqual({status:'closed'});expect(proof).toBeNull();expect(closeAccount).toHaveBeenCalledTimes(1)
  } finally {vi.useRealTimers()}
})

it('manually reads an unknown result without submitting closure a second time',async()=>{
  const localCleanup=createAccountClosureLocalCleanup({scope:{ownerId:'owner',localOperationId:'stable'},native:{receipt:{put:async()=>{},get:async()=>'opaque-proof',remove:async()=>{}},eraseLocal:async()=>({status:'complete',retainedUnattributed:[]})},journal:{write:async()=>{},read:async()=>null,remove:async()=>{}}})
  const closeAccount=vi.fn(async()=>({status:'processing' as const})),readResult=vi.fn(async()=>({status:'deleted' as const}))
  const flow=createFlow({platform:'android',stopAgent:async()=>({confirmed:true}),removeDevice:async()=>({confirmed:true}),closeAccount,readResult,localCleanup})
  await flow.start();expect(flow.getSnapshot().status).toBe('unconfirmed');await flow.checkResult();expect(flow.getSnapshot().status).toBe('closed')
  expect(closeAccount).toHaveBeenCalledTimes(1);expect(readResult).toHaveBeenCalledTimes(1)
})
