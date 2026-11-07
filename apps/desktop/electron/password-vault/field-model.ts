import { z } from 'zod'

export const descriptionSchema = z.string().max(65536)
export const fieldNameSchema = z.string().trim().min(1).max(256).refine(value => !/[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(value))
export const confidentialValueSchema = z.string().min(1).max(65536)
export const newFieldSchema = z.strictObject({ name: fieldNameSchema, value: confidentialValueSchema })
export const storedFieldSchema = newFieldSchema.extend({ id: z.uuid() })
export const fieldNameKey = (name: string): string => name.normalize('NFKC').toLowerCase()
export function uniqueFields(fields: ReadonlyArray<{ name: string; id?: string }>): boolean {
  return new Set(fields.map(field => fieldNameKey(field.name))).size === fields.length
    && new Set(fields.map(field => field.id).filter(id => id !== undefined)).size === fields.filter(field => field.id !== undefined).length
}
export const storedFieldsSchema = z.array(storedFieldSchema).refine(uniqueFields)

/** Best-effort removal of reachable strings; JavaScript strings cannot promise physical memory zeroing. */
export function clearCredential(value: { account: string; password: string; fields?: Array<{ value?: string }> }): void {
  value.account = ''; value.password = ''
  for (const field of value.fields ?? []) field.value = ''
}
