import { describe, expect, it } from 'vitest'
import type { LegAdapter } from '../../../apps/desktop/electron/session/main/core/sessions/session-life-adapter'
import { SessionLifeOwnerDrain } from '../../../apps/desktop/electron/session/main/core/sessions/session-life-drain'
import type { Gen, StageName, StageOut } from '../../../packages/core/src/local/session-life/types'

const gen = { auth: 1, attempt: 1 } as Gen
const processHave = { identity: { kind: 'private' }, workspace: { kind: 'none' }, capabilities: { kind: 'none' }, platform: { kind: 'none' }, cli: { kind: 'none' } } as const
function rig() {
  const acquired = { process: 'controlled-native-lease' }
  const started = Promise.withResolvers<StageOut['process']>()
  const released = Promise.withResolvers<void>()
  const teardownEntered = Promise.withResolvers<void>()
  let fail = false
  const adapter: LegAdapter = {
    leg: 'acp', timing: 'next-tool-call',
    async run<K extends StageName>(at: K): Promise<StageOut[K]> {
      if (at !== 'process') throw new Error('Unexpected fixture stage')
      return await started.promise as StageOut[K]
    },
    dispatch: async () => ({ result: 'accepted', nativeReceiptId: null }),
    teardown: async () => { teardownEntered.resolve(); await released.promise; if (fail) throw new Error('exit unconfirmed') },
    onExit: () => () => {},
  }
  return { adapter, started, released, teardownEntered, acquired: acquired as unknown as StageOut['process'], fail: () => { fail = true } }
}
describe('account closure runtime drain proof', () => {
  it('waits for a late start and its actual teardown instead of treating an aborted admission as an exit', async () => {
    const f = rig(), registry = new SessionLifeOwnerDrain(), adapter = registry.track('A', f.adapter)
    const start = adapter.run('process', processHave, { gen, signal: new AbortController().signal })
    const cleanup = start.then(process => adapter.teardown({ process }, { gen }))
    let drained = false
    const waiting = registry.drain('A').then(() => { drained = true })
    await Promise.resolve()
    expect(drained).toBe(false)
    f.started.resolve(f.acquired)
    await f.teardownEntered.promise
    expect(drained).toBe(false)
    f.released.resolve()
    await cleanup; await waiting
    expect(drained).toBe(true)
  })
  it('keeps proof for an old A generation while a new B generation remains live', async () => {
    const a = rig(), b = rig(), registry = new SessionLifeOwnerDrain()
    const old = registry.track('A', a.adapter), other = registry.track('B', b.adapter)
    a.started.resolve(a.acquired); b.started.resolve(b.acquired)
    const process = await old.run('process', processHave, { gen, signal: new AbortController().signal })
    await other.run('process', processHave, { gen, signal: new AbortController().signal })
    const stopping = old.teardown({ process }, { gen })
    a.released.resolve(); await stopping
    await expect(registry.drain('A')).resolves.toBeUndefined()
    await expect(registry.drain('B')).rejects.toThrow('unconfirmed')
  })
  it('retains a failed teardown as unconfirmed after the visible session was removed', async () => {
    const f = rig(), registry = new SessionLifeOwnerDrain(), adapter = registry.track('A', f.adapter)
    f.started.resolve(f.acquired); f.released.resolve(); f.fail()
    const process = await adapter.run('process', processHave, { gen, signal: new AbortController().signal })
    await expect(adapter.teardown({ process }, { gen })).rejects.toThrow('exit unconfirmed')
    await expect(registry.drain('A')).rejects.toThrow('unconfirmed')
  })
  it('also waits for an adapter cleanup detached from normal interactive teardown', async () => {
    const f = rig(), background = Promise.withResolvers<void>(), registry = new SessionLifeOwnerDrain()
    const adapter = registry.track('A', { ...f.adapter, closureDrain: () => background.promise })
    f.started.resolve(f.acquired); f.released.resolve()
    const process = await adapter.run('process', processHave, { gen, signal: new AbortController().signal })
    await adapter.teardown({ process }, { gen })
    let done = false
    const closing = registry.drain('A').then(() => { done = true })
    await Promise.resolve(); expect(done).toBe(false)
    background.resolve(); await closing
    expect(done).toBe(true)
  })
})
