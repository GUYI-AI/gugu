import { z } from 'zod'
import { createHash } from 'node:crypto'
import { domainToASCII } from 'node:url'
import type { AuditInput } from './contracts'
import { VaultError } from './contracts'

export const RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export const uuid = z.uuid()
export const identity = z.string().regex(/^(?:(?:user|session|agent):)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
export function httpsOrigin(input: string): string {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw new Error()
    return url.origin
  } catch { throw new VaultError('INVALID_INPUT') }
}
const origin = z.string().refine(value => { try { return httpsOrigin(value) === value } catch { return false } })
export const auditSchema = z.strictObject({
  id: uuid,
  action: z.enum(['pre-submit', 'setup', 'recovery', 'unlock', 'lock', 'add', 'edit', 'delete', 'grant', 'reveal', 'request', 'decision', 'use', 'invalidate', 'clear']),
  loginSurfaceId: uuid.optional(), agentId: identity.optional(), sessionId: identity.optional(), requestId: uuid.optional(), useId: uuid.optional(),
  credential: z.strictObject({ id: uuid, version: z.number().int().positive() }).optional(), origin: origin.optional(),
  decision: z.enum(['allow-once', 'reject', 'cancel', 'expire']).optional(),
  source: z.enum(['local-person', 'policy', 'browser', 'lifecycle']),
  outcome: z.enum(['pending', 'approved', 'rejected', 'cancelled', 'expired', 'invalidated', 'completed', 'failed', 'uncertain', 'submitted_unconfirmed', 'login_confirmed', 'person_interaction_required']),
})
export const recordSchema = auditSchema.extend({ id: uuid, at: z.iso.datetime(), accountId: identity })
/** A named value. `secret` (the default) keeps it from Agents: they see the name only and use it through password_fill.
 * A non-secret value (a host, a username, a project id) is readable by Agents with access to the credential. */
export const fieldSchema = z.strictObject({ id: uuid, name: z.string().trim().min(1).max(200), value: z.string().max(65536), secret: z.boolean().default(true) })
/** Other websites this credential may be filled into (an API key pasted into another service's settings). Its own origin is implied. */
export const sitesSchema = z.array(origin).max(64)
/** Grant subjects are verified native identities: one Agent, or every task session of one project. */
export const grantSchema = z.strictObject({ subject: z.string().regex(/^(?:agent|project):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i), level: z.enum(['read', 'write']) })
/** Edits may leave account/password/field values blank: blank keeps the stored value. */
export const credentialInputSchema = z.strictObject({ origin: z.string(), name: z.string().trim().max(200).optional(), account: z.string().max(4096),
  accountSecret: z.boolean().optional(), password: z.string().max(65536), fields: z.array(fieldSchema).max(64).default([]), sites: sitesSchema.optional() })
export const payloadSchema = z.strictObject({
  operations: z.array(z.strictObject({ id: uuid, kind: z.enum(['save', 'delete', 'grants']), status: z.enum(['pending', 'committed']), digest: z.string().regex(/^[a-f0-9]{64}$/), credentialId: uuid, version: z.number().int().positive(), origin, auditId: uuid })),
  // A credential holds at least one value; account and password may be empty (an API key alone). The account is
  // readable by Agents with access unless the person marks it secret; the password is always secret.
  credentials: z.array(z.strictObject({ id: uuid, version: z.number().int().positive(), origin, name: z.string().max(200).default(''),
    account: z.string().max(4096), accountSecret: z.boolean().default(false), password: z.string().max(65536),
    fields: z.array(fieldSchema).max(64).default([]), grants: z.array(grantSchema).max(1024).default([]), sites: sitesSchema.default([]) })),
})
const sealedSchema = z.strictObject({ nonce: z.string(), tag: z.string(), ciphertext: z.string() })
export const documentSchema = z.strictObject({
  schema: z.literal(1), owner: z.string().regex(/^[a-f0-9]{64}$/), installationId: uuid, vaultId: uuid,
  // recoveryKey exists only in vaults created by the retired setup flow; it is ignored.
  localKey: z.string(), recoveryKey: sealedSchema.optional(), payload: sealedSchema,
})
export const installationSchema = z.strictObject({ schema: z.literal(1), id: uuid, binding: z.string().regex(/^[a-f0-9]{64}$/), owners: z.array(z.string().regex(/^[a-f0-9]{64}$/)) })
export type VaultDocument = z.infer<typeof documentSchema>
export type VaultPayload = z.infer<typeof payloadSchema>
export type CredentialField = z.infer<typeof fieldSchema>
export type CredentialGrant = z.infer<typeof grantSchema>
export type Installation = z.infer<typeof installationSchema>
export function hash(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value)
  if (!result.success) throw new VaultError('DATA_DAMAGED')
  return result.data
}
export function auditInput(value: AuditInput): AuditInput {
  const result = auditSchema.safeParse(value)
  if (!result.success) throw new VaultError('INVALID_INPUT')
  return result.data
}
export function binding(document: Pick<VaultDocument, 'owner' | 'installationId' | 'vaultId'>, purpose: 'data' | 'recovery' | 'local'): string {
  return JSON.stringify(['gugu-password-vault', 1, document.owner, document.installationId, document.vaultId, purpose])
}
const accountCharacters = new Intl.Segmenter(undefined, { granularity: 'grapheme' })
const emailDomain = z.hostname()
export function maskedAccount(value: string): string {
  if (/[\p{Cc}\p{Cs}\p{Bidi_Control}]/u.test(value)) return '***'
  const input = value.trim()
  if (!input) return ''
  const at = input.indexOf('@'), domain = input.slice(at + 1)
  const email = at > 0 && at === input.lastIndexOf('@') && !/[\s"<>]/u.test(input.slice(0, at))
    && domain.includes('.') && /^[\p{L}\p{M}\p{N}.-]+$/u.test(domain)
    && emailDomain.safeParse(domainToASCII(domain)).success
  const local = email ? input.slice(0, at) : input
  const characters = [...accountCharacters.segment(local)]
  // A one-character account/local part has no private remainder to hide: redact it entirely.
  const suffix = email ? '@' + domain : ''
  const masked = (characters.length > 1 ? characters[0].segment : '') + '***' + suffix
  return masked === input ? '***' + suffix : masked
}
