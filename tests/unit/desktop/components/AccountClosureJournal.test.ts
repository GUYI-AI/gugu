import { describe, expect, it } from 'vitest'
import { createAccountClosureJournal, type AccountClosureMetadataStorage } from '../../../../apps/desktop/src/components/settings/accountDeletion/accountClosureJournal'
const A = '00000000-0000-4000-8000-000000000001', B = '00000000-0000-4000-8000-000000000002'
function memory() {
  const values = new Map<string, string>()
  const storage: AccountClosureMetadataStorage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => { values.set(key, value) }, removeItem: key => { values.delete(key) } }
  return { storage, values }
}
describe('account closure operation journal', () => {
  it('restores the exact operation after restart, stores metadata only, and leaves B unchanged', async () => {
    const f = memory(), a = { ownerId: A, localOperationId: 'opaque-operation-A' }, b = { ownerId: B, localOperationId: 'operation-B' }
    const first = createAccountClosureJournal(f.storage)
    await first.write(b)
    const before = [...f.values.values()][0]
    await first.write({ ...a, receipt: 'private-receipt-must-not-persist' } as typeof a)
    const reopened = createAccountClosureJournal(f.storage)
    expect(await reopened.read(A)).toEqual(a)
    expect([...f.values.values()].join()).not.toContain('private-receipt')
    await reopened.remove(a); await reopened.remove(a)
    expect(await reopened.read(A)).toBeNull()
    expect(await reopened.read(B)).toEqual(b)
    expect([...f.values.values()][0]).toBe(before)
  })
  it('refuses to replace or remove a different operation for the same owner', async () => {
    const f = memory(), journal = createAccountClosureJournal(f.storage)
    const original = { ownerId: A, localOperationId: 'original' }, other = { ...original, localOperationId: 'other' }
    await journal.write(original)
    await expect(journal.write(other)).rejects.toMatchObject({ code: 'scope_conflict' })
    await expect(journal.remove(other)).rejects.toMatchObject({ code: 'scope_conflict' })
    expect(await journal.read(A)).toEqual(original)
  })
  it.each(['broken-json-private-value', JSON.stringify({ ownerId: B, localOperationId: 'other' }), JSON.stringify({ ownerId: A, localOperationId: '', receipt: 'private-value' })])('refuses corrupt metadata without exposing its bytes', async raw => {
    const f = memory(), journal = createAccountClosureJournal(f.storage)
    await journal.write({ ownerId: A, localOperationId: 'original' })
    f.values.set([...f.values.keys()][0]!, raw)
    await expect(journal.read(A)).rejects.toMatchObject({ code: 'invalid_scope', message: 'invalid_scope' })
  })
  it('does not turn storage failure into an absent operation', async () => {
    const storage = { getItem: () => { throw new Error('private-storage-detail') }, setItem: () => {}, removeItem: () => {} }
    await expect(createAccountClosureJournal(storage).read(A)).rejects.toMatchObject({ code: 'closure_storage_unavailable', message: 'closure_storage_unavailable' })
  })
})
