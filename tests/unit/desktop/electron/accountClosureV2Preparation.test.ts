import { describe, expect, it } from 'vitest'
import { withAccountClosureV2Preparation } from '../../../../apps/desktop/src/platform/accountClosureV2Preparation'
import type { AccountClosureV2Native, AccountClosureV2Snapshot } from '../../../../apps/desktop/src/platform/accountClosureV2'

const id = '11111111-1111-4111-8111-111111111111'
const handle = { localOperationId: id, nativeGeneration: id, localRevision: 2 }
const original: AccountClosureV2Snapshot = { handle, ownerId: id, phase: 'challenge', serverOperation: null,
  serverPreparationGeneration: null, recoveryOnly: false, pendingEffect: null, agentsPaused: false, retainedUnattributed: [] }
describe('owner publication barrier around native V2 preparation', () => {
  it('passes only the original handle after its owner publication pause', async () => {
    const events: string[] = []
    const native = { discover: async () => { events.push('discover'); return original },
      prepare: async () => { events.push('native-prepare'); return { ...original, agentsPaused: true } } } as unknown as AccountClosureV2Native
    const facade = withAccountClosureV2Preparation(native, async owner => { expect(owner).toBe(id); events.push('pause') })
    await facade.prepare(handle)
    expect(events).toEqual(['discover', 'pause', 'native-prepare'])
  })
  it('refuses a changed operation, stale revision or recovery-only custody before publication effects', async () => {
    let found: AccountClosureV2Snapshot | null = original, effects = 0
    const native = { discover: async () => found, prepare: async () => { effects++; return original } } as unknown as AccountClosureV2Native
    const facade = withAccountClosureV2Preparation(native, async () => { effects++ })
    await expect(facade.prepare({ ...handle, localRevision: 1 })).rejects.toMatchObject({ code: 'scope_conflict' })
    found = null
    await expect(facade.prepare(handle)).rejects.toMatchObject({ code: 'scope_conflict' })
    found = { ...original, recoveryOnly: true }
    await expect(facade.prepare(handle)).rejects.toMatchObject({ code: 'closure_recovery_required' })
    expect(effects).toBe(0)
  })
  it('cannot dispatch native prepare/cancel when persisting the owner pause failed', async () => {
    let effects = 0
    const native = { discover: async () => original, prepare: async () => { effects++; return original },
      cancel: async () => { effects++; return original } } as unknown as AccountClosureV2Native
    const failure = Object.assign(new Error('Not durable'), { code: 'closure_storage_unavailable' })
    const facade = withAccountClosureV2Preparation(native, async () => { throw failure })
    await expect(facade.prepare(handle)).rejects.toBe(failure)
    expect(effects).toBe(0)
  })
})
