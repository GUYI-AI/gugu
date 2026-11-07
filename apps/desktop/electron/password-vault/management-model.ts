import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { VaultError, type CredentialReference } from './contracts'
import { credentialInputSchema, httpsOrigin, maskedAccount, type VaultPayload } from './schema'
import { descriptionSchema, fieldNameSchema, newFieldSchema, storedFieldsSchema, uniqueFields } from './field-model'
import type { VaultCreateInput, VaultEditMetadata, VaultEditPatch, VaultEntrySummary } from './management-contract'

export type StoredCredential = VaultPayload['credentials'][number]
export const referenceSchema = z.strictObject({ id: z.uuid(), version: z.number().int().positive(), epoch: z.uuid() })
const createSchema = credentialInputSchema.extend({ description: descriptionSchema.optional(), fields: z.array(newFieldSchema).refine(uniqueFields).optional() })
const editSchema = z.strictObject({
  origin: z.string().optional(), description: descriptionSchema.optional(), account: z.string().max(4096).optional(), password: z.string().max(65536).optional(),
  fields: z.array(z.strictObject({ id: z.uuid(), name: fieldNameSchema.optional(), value: z.string().max(65536).optional() })).optional(),
  addFields: z.array(newFieldSchema).optional(), removeFieldIds: z.array(z.uuid()).optional(),
})
function input<T>(schema: z.ZodType<T>, value: unknown): T {
  try { const result = schema.safeParse(value); if (result.success) return result.data } catch { /* Never expose a validation body or getter error. */ }
  throw new VaultError('INVALID_INPUT')
}
export function createInput(value: VaultCreateInput): VaultCreateInput {
  const parsed = input(createSchema, value)
  return { ...parsed, origin: httpsOrigin(parsed.origin) }
}
export function editInput(value: VaultEditPatch): VaultEditPatch {
  const parsed = input(editSchema, value)
  return { ...parsed, ...(parsed.origin === undefined ? {} : { origin: httpsOrigin(parsed.origin) }) }
}
export function editCredentialValue(old: StoredCredential, patch: VaultEditPatch): Omit<StoredCredential, 'id' | 'version'> {
  const updates = patch.fields ?? [], removals = patch.removeFieldIds ?? []
  if (new Set(updates.map(field => field.id)).size !== updates.length || new Set(removals).size !== removals.length
    || updates.some(field => removals.includes(field.id) || !old.fields.some(item => item.id === field.id))
    || removals.some(id => !old.fields.some(field => field.id === id))) throw new VaultError('INVALID_INPUT')
  const fields = old.fields.filter(field => !removals.includes(field.id)).map(field => {
    const update = updates.find(item => item.id === field.id)
    return { ...field, ...(update?.name === undefined ? {} : { name: update.name }), ...(update?.value ? { value: update.value } : {}) }
  }).concat((patch.addFields ?? []).map(field => ({ ...field, id: randomUUID() })))
  if (!storedFieldsSchema.safeParse(fields).success) throw new VaultError('INVALID_INPUT')
  return { origin: patch.origin ?? old.origin, account: patch.account || old.account, password: patch.password || old.password,
    description: patch.description ?? old.description, fields }
}
export function entrySummary(value: StoredCredential, epoch: string): VaultEntrySummary {
  return { reference: { id: value.id, version: value.version, epoch }, origin: value.origin, maskedAccount: maskedAccount(value.account),
    description: value.description, fieldNames: value.fields.map(field => field.name) }
}
export function editMetadata(value: StoredCredential, reference: CredentialReference): VaultEditMetadata {
  return { ...entrySummary(value, reference.epoch), fields: value.fields.map(({ id, name }) => ({ id, name })) }
}
