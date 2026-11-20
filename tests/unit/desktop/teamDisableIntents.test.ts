import { expect, it } from 'vitest'
import { createTeamDisableIntentStore } from '../../../apps/desktop/src/features/team/disableIntentStore'

function memory() {
  const values = new Map<string, string>()
  return { values, getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value) }, removeItem: (key: string) => { values.delete(key) } }
}
it('recovers the same command after a lost response, then resumes only the returned operation', () => {
  const storage = memory(), first = createTeamDisableIntentStore(storage, 't1', 'admin1', 'member1')
  const intent = { member_id: 'member1', expected_revision: 7, handoff_member_id: 'super1', idempotency_key: 'command1' }
  first.prepare(intent)
  const reloaded = createTeamDisableIntentStore(storage, 't1', 'admin1', 'member1')
  expect(reloaded.prepare({ ...intent, expected_revision: 8, idempotency_key: 'new-command' })).toEqual(intent)
  reloaded.noteOperation('command1', 'operation1')
  expect(reloaded.decode(reloaded.raw())?.operation_id).toBe('operation1')
  expect(() => reloaded.complete('wrong-command')).toThrow()
  expect(reloaded.raw()).not.toBeNull()
  reloaded.complete('command1'); expect(reloaded.raw()).toBeNull()
})
it('keeps receipts scoped to the administrator and team and stores identifiers without private input', () => {
  const storage = memory(), store = createTeamDisableIntentStore(storage, 't1', 'admin1', 'member1')
  store.prepare({ member_id: 'member1', expected_revision: 7, idempotency_key: 'command1' })
  expect(createTeamDisableIntentStore(storage, 't2', 'admin1', 'member1').raw()).toBeNull()
  expect(createTeamDisableIntentStore(storage, 't1', 'admin2', 'member1').raw()).toBeNull()
  const row = JSON.parse([...storage.values.values()][0])
  expect(Object.keys(row).sort()).toEqual(['actor_id', 'expected_revision', 'idempotency_key', 'member_id', 'team_id', 'version'])
})
