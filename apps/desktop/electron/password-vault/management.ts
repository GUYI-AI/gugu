import { createHmac, randomUUID } from 'node:crypto'
import type { AuditInput, CredentialGrant, CredentialInput, CredentialReference, CredentialSummary } from './contracts'
import { VaultError } from './contracts'
import { maskedAccount, type VaultPayload } from './schema'

type StoredCredential = VaultPayload['credentials'][number]
export interface ManagementRuntime {
  key: Buffer; epoch: string; payload: VaultPayload
  check(reference: CredentialReference): StoredCredential
  current(): void
  persist(payload: VaultPayload): Promise<void>
  record(event: AuditInput): Promise<string>
  /** Cross-device sync: the cloud write happens first; a refusal (stale, offline) aborts before the local commit. */
  publish(change: SyncChange): Promise<void>
  cleanup: Promise<boolean>
}
export type SyncValue = Omit<StoredCredential, 'id' | 'version'>
export type SyncChange = { kind: 'save'; id: string; value: SyncValue } | { kind: 'delete'; id: string }
export const summary = (value: StoredCredential, epoch: string): CredentialSummary => ({
  reference: { id: value.id, version: value.version, epoch }, name: value.name, origin: value.origin,
  ...(value.accountSecret ? {} : { account: value.account }), maskedAccount: maskedAccount(value.account), accountSecret: value.accountSecret,
  hasPassword: !!value.password,
  fields: value.fields.map(field => ({ id: field.id, name: field.name, secret: field.secret, ...(field.secret ? {} : { value: field.value }) })),
  grants: value.grants.map(grant => ({ ...grant })), sites: [...value.sites],
})
const result = (operation: VaultPayload['operations'][number], payload: VaultPayload, epoch: string): CredentialSummary => {
  const value = payload.credentials.find(item => item.id === operation.credentialId)
  if (!value) throw new VaultError('STALE_REFERENCE')
  return summary(value, epoch)
}
export type ValidatedInput = Omit<Required<CredentialInput>, 'name' | 'accountSecret' | 'sites' | 'fields'>
  & { name?: string; accountSecret?: boolean; sites?: string[]; fields: { id: string; name: string; value: string; secret: boolean }[] }
/** Blank account/password/field values keep the stored value; a field absent from the input is removed. A credential
 * holds at least one value. Omitted name, secret marks and sites keep the stored ones. */
function merged(input: ValidatedInput, old?: StoredCredential) {
  const account = input.account || old?.account || '', password = input.password || old?.password || ''
  const names = new Set<string>()
  const fields = input.fields.map(field => {
    const value = field.value || old?.fields.find(item => item.id === field.id)?.value || ''
    if (!value || names.has(field.name)) throw new VaultError('INVALID_INPUT')
    names.add(field.name)
    return { id: field.id, name: field.name, value, secret: field.secret }
  })
  if (!account && !password && !fields.length) throw new VaultError('INVALID_INPUT')
  return { origin: input.origin, name: input.name ?? old?.name ?? '', account, accountSecret: input.accountSecret ?? old?.accountSecret ?? false,
    password, fields, sites: input.sites ?? old?.sites ?? [] }
}
function receipt(operation: VaultPayload['operations'][number], action: 'add' | 'edit' | 'delete'): AuditInput {
  return { id: operation.auditId, action, source: 'local-person', outcome: 'completed',
    credential: { id: operation.credentialId, version: operation.version }, origin: operation.origin }
}
/** The encrypted operation ledger makes lost responses/restarts safe to retry under the original operation id. */
export async function saveCredential(runtime: ManagementRuntime, operationId: string, input: ValidatedInput, previous?: CredentialReference,
  creator?: CredentialGrant): Promise<CredentialSummary> {
  const { key, epoch, payload } = runtime
  // The durable request binds the credential/version, while runtime.check separately validates
  // the current unlock epoch. A failed audit must not strand the operation after re-unlock.
  const base = previous ? { id: previous.id, version: previous.version } : undefined
  const digest = createHmac('sha256', key).update(JSON.stringify({ input, previous: base })).digest('hex')
  let operation = payload.operations.find(item => item.id === operationId)
  if (operation && (operation.kind !== 'save' || operation.digest !== digest)) throw new VaultError('INVALID_INPUT')
  const action = previous ? 'edit' : 'add'
  if (operation?.status === 'committed') { await runtime.record(receipt(operation, action)); return result(operation, payload, epoch) }
  const old = previous ? runtime.check(previous) : undefined
  const value = merged(input, old)
  if (!await runtime.cleanup) throw new VaultError('UNAVAILABLE')
  runtime.current()
  if (!operation) {
    operation = { id: operationId, kind: 'save', status: 'pending', digest, credentialId: old?.id ?? randomUUID(), version: (old?.version ?? 0) + 1, origin: input.origin, auditId: randomUUID() }
    payload.operations.push(operation)
    // Pending metadata contains no new account/password. A changed-body retry cannot reuse the id.
    await runtime.persist(payload)
  }
  await runtime.record({ id: operationId, action, source: 'local-person', outcome: 'pending', ...(old ? { credential: { id: old.id, version: old.version } } : {}), origin: input.origin })
  runtime.current()
  // An Agent that creates a credential may keep maintaining it; nobody else gains access.
  const grants = old ? old.grants : creator ? [creator] : []
  await runtime.publish({ kind: 'save', id: operation.credentialId, value: { ...value, grants } })
  runtime.current()
  payload.credentials = [...payload.credentials.filter(item => item.id !== operation!.credentialId), { ...value, grants, id: operation.credentialId, version: operation.version }]
  operation.status = 'committed'
  await runtime.persist(payload)
  await runtime.record(receipt(operation, action))
  return result(operation, payload, epoch)
}
export async function deleteCredential(runtime: ManagementRuntime, operationId: string, reference: CredentialReference): Promise<void> {
  const { key, payload } = runtime
  const digest = createHmac('sha256', key).update(JSON.stringify({ id: reference.id, version: reference.version })).digest('hex')
  let operation = payload.operations.find(item => item.id === operationId)
  if (operation && (operation.kind !== 'delete' || operation.digest !== digest)) throw new VaultError('INVALID_INPUT')
  if (operation?.status === 'committed') { await runtime.record(receipt(operation, 'delete')); return }
  const old = runtime.check(reference)
  if (!await runtime.cleanup) throw new VaultError('UNAVAILABLE')
  runtime.current()
  if (!operation) {
    operation = { id: operationId, kind: 'delete', status: 'pending', digest, credentialId: old.id, version: old.version, origin: old.origin, auditId: randomUUID() }
    payload.operations.push(operation); await runtime.persist(payload)
  }
  await runtime.record({ id: operationId, action: 'delete', source: 'local-person', outcome: 'pending', credential: { id: old.id, version: old.version }, origin: old.origin })
  runtime.current(); await runtime.publish({ kind: 'delete', id: old.id })
  runtime.current(); payload.credentials = payload.credentials.filter(item => item.id !== old.id); operation.status = 'committed'
  await runtime.persist(payload); await runtime.record(receipt(operation, 'delete'))
}

/** Person-only. Grants never change secret values, so the credential version is kept. */
export async function updateGrants(runtime: ManagementRuntime, reference: CredentialReference, grants: CredentialGrant[]): Promise<CredentialSummary> {
  const old = runtime.check(reference)
  const unique = new Map(grants.map(grant => [grant.subject, grant.level] as const))
  runtime.current()
  const next = [...unique].map(([subject, level]) => ({ subject, level }))
  const { id: _id, version: _version, ...value } = old
  await runtime.publish({ kind: 'save', id: old.id, value: { ...value, grants: next } })
  runtime.current()
  old.grants = next
  await runtime.persist(runtime.payload)
  await runtime.record({ id: randomUUID(), action: 'grant', source: 'local-person', outcome: 'completed', credential: { id: old.id, version: old.version }, origin: old.origin })
  return summary(old, runtime.epoch)
}
