import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withAccountClosureV2Preparation } from '../../apps/desktop/src/platform/accountClosureV2Preparation.ts'
import type { AccountClosureV2Native, AccountClosureV2Snapshot } from '../../apps/desktop/src/platform/accountClosureV2.ts'

const id = '11111111-1111-4111-8111-111111111111'
const handle = { localOperationId: id, nativeGeneration: id, localRevision: 2 }
const original: AccountClosureV2Snapshot = { handle, ownerId: id, phase: 'challenge', serverOperation: null,
  serverPreparationGeneration: null, recoveryOnly: false, pendingEffect: null, agentsPaused: false, retainedUnattributed: [] }
test('only the original handle passes the owner publication barrier before native prepare', async () => {
  const events: string[] = []
  const native = { discover: async () => { events.push('discover'); return original },
    prepare: async () => { events.push('native-prepare'); return { ...original, agentsPaused: true } } } as unknown as AccountClosureV2Native
  const facade = withAccountClosureV2Preparation(native, async owner => { assert.equal(owner, id); events.push('pause') })
  await facade.prepare(handle)
  assert.deepEqual(events, ['discover', 'pause', 'native-prepare'])
})
test('changed native operation, stale revision or recovery-only custody causes no publication effects', async () => {
  let found: AccountClosureV2Snapshot | null = original, effects = 0
  const native = { discover: async () => found, prepare: async () => { effects++; return original } } as unknown as AccountClosureV2Native
  const facade = withAccountClosureV2Preparation(native, async () => { effects++ })
  await assert.rejects(facade.prepare({ ...handle, localRevision: 1 }), { code: 'scope_conflict' })
  found = null
  await assert.rejects(facade.prepare(handle), { code: 'scope_conflict' })
  found = { ...original, recoveryOnly: true }
  await assert.rejects(facade.prepare(handle), { code: 'closure_recovery_required' })
  assert.equal(effects, 0)
})
test('failure to persist the owner pause cannot dispatch native prepare or cancellation', async () => {
  let effects = 0
  const native = { discover: async () => original, prepare: async () => { effects++; return original },
    cancel: async () => { effects++; return original } } as unknown as AccountClosureV2Native
  const failure = Object.assign(new Error('Not durable'), { code: 'closure_storage_unavailable' })
  const facade = withAccountClosureV2Preparation(native, async () => { throw failure })
  await assert.rejects(facade.prepare(handle), error => error === failure)
  assert.equal(effects, 0)
})
