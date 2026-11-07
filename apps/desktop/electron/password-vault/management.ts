import { createHmac, randomUUID } from 'node:crypto'
import type { AuditInput, CredentialReference, CredentialSummary } from './contracts'
import { VaultError } from './contracts'
import { maskedAccount, type VaultPayload } from './schema'
import { editCredentialValue, type StoredCredential } from './management-model'
import type { VaultCreateInput, VaultEditPatch, VaultMutationResult } from './management-contract'

type Operation = VaultPayload['operations'][number]
type CredentialValue = Omit<StoredCredential, 'id' | 'version'>
export interface ManagementRuntime {
  key: Buffer; epoch: string; payload: VaultPayload
  check(reference: CredentialReference): StoredCredential
  current(): void
  persist(payload: VaultPayload, entryCommit?: boolean): Promise<void>
  protect(value: CredentialValue): () => void
  record(event: AuditInput): Promise<string>
  cleanup: Promise<boolean>
}
function receipt(operation: Operation, action: 'add' | 'edit' | 'delete'): AuditInput {
  return { id: operation.auditId, action, source: 'local-person', outcome: 'completed',
    credential: { id: operation.credentialId, version: operation.version }, origin: operation.origin }
}
/** Recovery reads this encrypted ledger; it neither repeats a write nor grants use permission. */
export function mutationResult(operation: Operation, epoch: string): VaultMutationResult {
  return { reference: { id: operation.credentialId, version: operation.version, epoch }, fieldNames: [...(operation.fieldNames ?? [])] }
}
async function mutate(runtime: ManagementRuntime, operationId: string, kind: Operation['kind'], body: unknown,
  previous: CredentialReference | undefined, make: (old?: StoredCredential) => CredentialValue | undefined): Promise<Operation> {
  const { key, payload } = runtime
  // Epoch is checked by the writer, not part of the durable request digest: a re-unlock can resume a pending operation.
  const digest = createHmac('sha256', key).update(JSON.stringify(body)).digest('hex')
  let operation = payload.operations.find(item => item.id === operationId)
  if (operation && (operation.kind !== kind || operation.digest !== digest)) throw new VaultError('INVALID_INPUT')
  const action = kind === 'delete' ? 'delete' : previous ? 'edit' : 'add'
  if (operation?.status === 'committed') { runtime.current(); await runtime.record(receipt(operation, action)); runtime.current(); return operation }
  const old = previous ? runtime.check(previous) : undefined, next = make(old)
  const release = next ? runtime.protect(next) : () => undefined
  const releaseOld = old ? runtime.protect(old) : () => undefined
  try {
    if (!await runtime.cleanup) throw new VaultError('UNAVAILABLE')
    runtime.current()
    if (!operation) {
      operation = { id: operationId, kind, status: 'pending', digest, credentialId: old?.id ?? randomUUID(),
        version: (old?.version ?? 0) + (kind === 'delete' ? 0 : 1), origin: next?.origin ?? old!.origin, auditId: randomUUID() }
      payload.operations.push(operation)
      // No new confidential input is persisted until its pre-commit audit is reliable.
      await runtime.persist(payload); runtime.current()
    }
    await runtime.record({ id: operationId, action, source: 'local-person', outcome: 'pending',
      ...(old ? { credential: { id: old.id, version: old.version } } : {}), origin: operation.origin })
    runtime.current()
    operation.fieldNames = (next?.fields ?? old?.fields ?? []).map(field => field.name)
    payload.credentials = payload.credentials.filter(item => item.id !== operation!.credentialId)
    if (next) payload.credentials.push({ ...next, id: operation.credentialId, version: operation.version })
    operation.status = 'committed'
    await runtime.persist(payload, true); runtime.current()
    await runtime.record(receipt(operation, action)); runtime.current()
    return operation
  } finally { release(); releaseOld() }
}
/** Existing password-only callers retain their original digest and preserve newly added metadata on edit. */
export async function saveCredential(runtime: ManagementRuntime, operationId: string, input: VaultCreateInput, previous?: CredentialReference): Promise<CredentialSummary> {
  const base = previous ? { id: previous.id, version: previous.version } : undefined
  const operation = await mutate(runtime, operationId, 'save', { input, previous: base }, previous, old => ({
    origin: input.origin, account: input.account, password: input.password, description: input.description ?? old?.description ?? '',
    fields: input.fields?.map(field => ({ ...field, id: randomUUID() })) ?? old?.fields.map(field => ({ ...field })) ?? [],
  }))
  return { reference: mutationResult(operation, runtime.epoch).reference, origin: operation.origin, maskedAccount: maskedAccount(input.account) }
}
export async function editCredential(runtime: ManagementRuntime, operationId: string, reference: CredentialReference, patch: VaultEditPatch): Promise<VaultMutationResult> {
  const operation = await mutate(runtime, operationId, 'edit', { patch, previous: { id: reference.id, version: reference.version } }, reference,
    old => editCredentialValue(old!, patch))
  return mutationResult(operation, runtime.epoch)
}
export async function deleteCredential(runtime: ManagementRuntime, operationId: string, reference: CredentialReference): Promise<void> {
  await mutate(runtime, operationId, 'delete', { id: reference.id, version: reference.version }, reference, () => undefined)
}
