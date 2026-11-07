import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { inspect } from 'node:util'
import { canary, committed, fixture, request, bytesUnder } from './management-fixture'
import { payloadSchema } from '../../../apps/desktop/electron/password-vault/schema'

describe('native credential management model and safe projection', () => {
  it('stores confidential values under stable ids and returns only approved safe projections', async () => {
    const f = await fixture(), input = canary(), id = randomUUID(), r = request()
    const saved = committed(await f.port.create(f.person, id, input, r.guard))
    const query = await f.port.query(f.agent), metadata = await f.port.describeEdit(f.person, saved.reference), payload = await f.payload()
    expect(query[0].description).toBe(input.description); expect(query[0].fieldNames).toEqual(['API Key', 'TOTP seed'])
    expect(metadata.fields.map(field => field.name)).toEqual(query[0].fieldNames)
    expect(new Set(metadata.fields.map(field => field.id)).size).toBe(2)
    expect(payload.credentials[0].fields.map(field => field.id)).toEqual(metadata.fields.map(field => field.id))
    expect(payload.credentials[0].fields.every((field, index) => field.value === input.fields![index].value)).toBe(true)
    const publicBytes = JSON.stringify([saved, query, metadata, await f.port.operationResult(f.person, id), await f.vault.readAudit(f.person)]) + inspect(f.vault)
    const files = await bytesUnder(f.root)
    for (const value of [input.account, input.password, ...input.fields!.map(field => field.value)]) {
      expect(publicBytes.includes(value)).toBe(false)
      for (const encoded of [value, Buffer.from(value).toString('base64'), Buffer.from(value).toString('hex'), encodeURIComponent(value)]) expect(files.some(bytes => bytes.includes(encoded))).toBe(false)
    }
    expect(Buffer.from(input.password).includes(input.password)).toBe(true)
    expect(Object.isFrozen(f.port)).toBe(true)
  })
  it('preserves blank values, renames by id, removes only explicit fields and clears description explicitly', async () => {
    const f = await fixture(), input = canary(), original = committed(await f.port.create(f.person, randomUUID(), input, request().guard))
    const before = await f.port.describeEdit(f.person, original.reference), [first, second] = before.fields
    const edited = committed(await f.port.edit(f.person, randomUUID(), original.reference,
      { account: '', password: '', description: '', fields: [{ id: first.id, name: 'Renamed key', value: '' }] }, request().guard))
    const retained = (await f.payload()).credentials[0]
    expect(retained.account === input.account && retained.password === input.password).toBe(true)
    expect(retained.fields[0].id).toBe(first.id); expect(retained.fields[0].value === input.fields![0].value).toBe(true)
    expect(retained.fields[1].id).toBe(second.id); expect(retained.description).toBe('')
    const removed = committed(await f.port.edit(f.person, randomUUID(), edited.reference,
      { removeFieldIds: [second.id], addFields: [{ name: 'New confidential field', value: randomUUID() }] }, request().guard))
    const after = await f.port.describeEdit(f.person, removed.reference)
    expect(after.fieldNames).toEqual(['Renamed key', 'New confidential field'])
    expect(after.fields[0].id).toBe(first.id); expect(after.fields[1].id === second.id).toBe(false)
    expect((await f.vault.checkReference(f.agent, original.reference)).status).toBe('invalidated')
  })
  it('changes secret values only from native edits and preserves new metadata for legacy password-only editing', async () => {
    const f = await fixture(), input = canary(), saved = committed(await f.port.create(f.person, randomUUID(), input, request().guard))
    const first = (await f.port.describeEdit(f.person, saved.reference)).fields[0], replacement = randomUUID()
    const edited = committed(await f.port.edit(f.person, randomUUID(), saved.reference, { fields: [{ id: first.id, value: replacement }] }, request().guard))
    const legacy = await f.vault.save(f.person, randomUUID(), { origin: input.origin, account: input.account, password: input.password }, edited.reference)
    const retained = (await f.payload()).credentials[0]
    expect(retained.fields[0].id).toBe(first.id); expect(retained.fields[0].value === replacement).toBe(true)
    expect((await f.port.query(f.agent))[0].description).toBe(input.description)
    expect(legacy.reference.version).toBe(3)
  })
  it.each(['duplicate-name', 'confusable-name', 'empty-name', 'visibility', 'unknown-id', 'duplicate-id', 'remove-and-edit', 'implicit-clear'])(
    'refuses %s without changing the entry', async scenario => {
      const f = await fixture(), input = canary(), saved = committed(await f.port.create(f.person, randomUUID(), input, request().guard))
      const field = (await f.port.describeEdit(f.person, saved.reference)).fields[0]
      const patch = scenario === 'duplicate-name' ? { addFields: [{ name: 'API KEY', value: randomUUID() }] }
        : scenario === 'confusable-name' ? { addFields: [{ name: 'ＡＰＩ Ｋｅｙ', value: randomUUID() }] }
          : scenario === 'empty-name' ? { fields: [{ id: field.id, name: '  ' }] }
            : scenario === 'visibility' ? { fields: [{ id: field.id, visibleToAgent: true }] }
              : scenario === 'unknown-id' ? { removeFieldIds: [randomUUID()] }
                : scenario === 'duplicate-id' ? { fields: [{ id: field.id }, { id: field.id }] }
                  : scenario === 'remove-and-edit' ? { fields: [{ id: field.id }], removeFieldIds: [field.id] }
                    : { addFields: [{ name: 'Blank value', value: '' }] }
      expect(await f.port.edit(f.person, randomUUID(), saved.reference, patch, request().guard)).toMatchObject({ status: 'not_committed', code: 'INVALID_INPUT' })
      expect((await f.port.query(f.agent))[0].reference.version).toBe(1)
    })
  it('serializes concurrent old-version edits and rejects stale delete without overwriting the winner', async () => {
    const f = await fixture(), original = committed(await f.port.create(f.person, randomUUID(), canary(), request().guard))
    const [winner, loser] = await Promise.all([
      f.port.edit(f.person, randomUUID(), original.reference, { description: 'First change' }, request().guard),
      f.port.edit(f.person, randomUUID(), original.reference, { description: 'Stale change' }, request().guard),
    ])
    expect(winner.status).toBe('committed'); expect(loser).toMatchObject({ status: 'not_committed', code: 'STALE_REFERENCE' })
    expect(await f.port.delete(f.person, randomUUID(), original.reference, request().guard)).toMatchObject({ status: 'not_committed', code: 'STALE_REFERENCE' })
    expect((await f.port.query(f.agent))[0].description).toBe('First change')
  })
  it('allows owned local Agent queries but never person-only metadata, mutation or ledger recovery', async () => {
    const f = await fixture(), saved = committed(await f.port.create(f.person, randomUUID(), canary(), request().guard))
    await expect(f.port.query({})).rejects.toThrow()
    await expect(f.port.describeEdit(f.agent, saved.reference)).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    await expect(f.port.operationResult(f.agent, randomUUID())).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(await f.port.create(f.agent, randomUUID(), canary(), request().guard)).toMatchObject({ status: 'uncertain', code: 'UNAVAILABLE' })
  })
  it('reads old encrypted payload records without manufacturing custom fields or changing the legacy operation digest', async () => {
    const id = randomUUID(), value = canary()
    const parsed = payloadSchema.parse({ credentials: [{ id, version: 1, origin: value.origin, account: value.account, password: value.password }], operations: [] })
    expect(parsed.credentials[0].fields).toEqual([]); expect(parsed.credentials[0].description).toBe('')
    const f = await fixture(), operation = randomUUID(), input = { origin: value.origin, account: value.account, password: value.password }
    const first = await f.vault.save(f.person, operation, input)
    await f.vault.lock(); await f.vault.unlock(f.person)
    expect((await f.vault.save(f.person, operation, input)).reference.id).toBe(first.reference.id)
    expect(vi.mocked(f.dependencies.invalidate).mock.calls.some(([event]) => event.reason === 'edit')).toBe(false)
  })
})
