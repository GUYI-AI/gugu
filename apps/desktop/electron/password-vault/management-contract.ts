import type { CredentialReference, CredentialSummary, VaultCode } from './contracts'

/** Native local form inputs only. These types must never become MCP/form/message argument schemas. */
export interface VaultCreateInput {
  origin: string
  account: string
  password: string
  description?: string
  fields?: ReadonlyArray<{ name: string; value: string }>
}

export interface VaultEditPatch {
  origin?: string
  description?: string
  /** Missing or empty confidential inputs preserve the existing value. */
  account?: string
  password?: string
  fields?: ReadonlyArray<{ id: string; name?: string; value?: string }>
  addFields?: ReadonlyArray<{ name: string; value: string }>
  removeFieldIds?: readonly string[]
}

/** These projections contain no full account, password or custom value. */
export interface VaultEntrySummary extends CredentialSummary {
  description: string
  fieldNames: string[]
}
export interface VaultEditMetadata extends VaultEntrySummary {
  fields: Array<{ id: string; name: string }>
}
export interface VaultMutationResult {
  reference: CredentialReference
  fieldNames: string[]
}
export type VaultMutationOutcome = { status: 'committed'; result: VaultMutationResult }
  | { status: 'not_committed' | 'uncertain'; code: VaultCode }

/** Captured from the originating trusted request lifetime, never from Agent arguments. */
export interface VaultMutationGuard {
  readonly signal: AbortSignal
  assertCurrent(): void
}

/** One fixed port on the existing vault. It owns no approval, secret export or separate key state. */
export interface VaultManagementPort {
  query(actor: object): Promise<VaultEntrySummary[]>
  describeEdit(person: object, reference: CredentialReference): Promise<VaultEditMetadata>
  create(person: object, operationId: string, input: VaultCreateInput, guard: VaultMutationGuard): Promise<VaultMutationOutcome>
  edit(person: object, operationId: string, reference: CredentialReference, patch: VaultEditPatch, guard: VaultMutationGuard): Promise<VaultMutationOutcome>
  delete(person: object, operationId: string, reference: CredentialReference, guard: VaultMutationGuard): Promise<VaultMutationOutcome>
  /** Read-only recovery after a response loss. Pending/unknown are not permission to repeat a mutation. */
  operationResult(person: object, operationId: string): Promise<
    { status: 'unknown' | 'pending' } | { status: 'committed'; result: VaultMutationResult }
  >
}
