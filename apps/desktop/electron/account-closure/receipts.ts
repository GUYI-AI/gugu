import { createHash } from 'node:crypto'
import type { AccountClosureErrorCode, AccountClosureNative, AccountClosureResult, AccountClosureScope } from '../../src/platform/accountClosure'

interface Preparation { epoch: string; ready: boolean }
export interface DesktopClosureReceiptPorts {
  /** Production supplies the existing system-encrypted App secrets store. */
  secrets: { getSecret(key: string): Promise<string | null>; setSecret(key: string, value: string): Promise<void> }
  installation(create?: boolean): Promise<string | null>
  currentOwner(): Promise<string | null | undefined>
  /** Shared with local auth writes, not just with other receipt operations. */
  underAuth<T>(operation: () => Promise<T>): Promise<T>
  /** Evidence must name this exact operation, not only its account. Missing evidence rejects. */
  preparation(scope: AccountClosureScope): Promise<Preparation>
  /** Persist the native auth-write fence before the first destructive effect. */
  beforeErase(scope: AccountClosureScope): Promise<void>
  /** Each effect is owner-scoped and safe to repeat after an interrupted checkpoint. */
  steps: readonly { name: string; run(scope: AccountClosureScope): Promise<boolean> }[]
  retained(): Promise<string[]>
}
interface Captured {
  version: 1
  key: string
  receipt: string | null
  epoch: string | null
  stepNames: string[]
  next: number
  complete: boolean
  retained: string[]
}
export class ClosureFailure extends Error {
  constructor(readonly code: AccountClosureErrorCode) { super(code) }
}
const fail = (code: AccountClosureErrorCode): never => { throw new ClosureFailure(code) }
const fixedName = /^[a-z][a-z0-9-]{0,127}$/
function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value, 'utf8') <= max && Buffer.from(value, 'utf8').toString('utf8') === value
}
export function scopeOf(input: AccountClosureScope): Readonly<AccountClosureScope> {
  if (!input || typeof input.ownerId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(input.ownerId)
    || !boundedText(input.localOperationId, 256)) return fail('invalid_scope')
  return Object.freeze({ ownerId: input.ownerId, localOperationId: input.localOperationId })
}
function names(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 64 && value.every(item => typeof item === 'string' && fixedName.test(item))
}

/** Protected operation custody. No request, retry timer, raw-secret log or plaintext fallback. */
export function createDesktopClosureReceipts(ports: DesktopClosureReceiptPorts): AccountClosureNative & {
  /** Called by native preparation after its operation-bound fence has been persisted. */
  bindPreparation(scope: AccountClosureScope): Promise<void>
  requireCancelledPreparation(scope: AccountClosureScope): Promise<string>
} {
  const stepNames = ports.steps.map(step => step.name)
  if (!names(stepNames) || new Set(stepNames).size !== stepNames.length) throw new Error('Invalid closure cleanup plan')
  async function owned(scope: AccountClosureScope, capturing = false) {
    const owner = await ports.currentOwner()
    if (owner === undefined) fail('closure_storage_unavailable')
    if ((capturing && owner !== scope.ownerId) || (owner !== null && owner !== scope.ownerId)) fail('wrong_local_owner')
  }
  const run = async <T>(input: AccountClosureScope, operation: (scope: Readonly<AccountClosureScope>) => Promise<T>) => {
    const scope = scopeOf(input)
    return ports.underAuth(async () => {
      try { return await operation(scope) }
      catch (error) { throw error instanceof ClosureFailure ? error : new ClosureFailure('closure_storage_unavailable') }
    })
  }
  async function keyFor(scope: AccountClosureScope, create = false): Promise<string | null> {
    const installation = await ports.installation(create)
    if (installation === null && !create) return null
    if (!boundedText(installation, 256)) fail('closure_storage_unavailable')
    return `account-closure:${createHash('sha256').update(JSON.stringify([installation, scope.ownerId, scope.localOperationId])).digest('hex')}`
  }
  async function read(scope: AccountClosureScope): Promise<Captured | null> {
    const key = await keyFor(scope)
    if (key === null) return null
    const raw = await ports.secrets.getSecret(key)
    if (raw === null) return null
    if (Buffer.byteLength(raw, 'utf8') > 100_000) return fail('closure_storage_unavailable')
    const value = JSON.parse(raw) as Partial<Captured>
    if (!value || value.version !== 1 || value.key !== key
      || (value.receipt !== null && !boundedText(value.receipt, 65_536))
      || (value.epoch !== null && !boundedText(value.epoch, 256))
      || !names(value.stepNames) || JSON.stringify(value.stepNames) !== JSON.stringify(stepNames)
      || !Number.isInteger(value.next) || value.next! < 0 || value.next! > stepNames.length
      || typeof value.complete !== 'boolean' || (value.complete && value.next !== stepNames.length)
      || !names(value.retained)) return fail('closure_storage_unavailable')
    return value as Captured
  }
  const required = async (scope: AccountClosureScope) => await read(scope) ?? fail('closure_context_missing')
  const save = (record: Captured) => ports.secrets.setSecret(record.key, JSON.stringify(record))
  async function retained() {
    const value = await ports.retained()
    if (!names(value)) return fail('closure_storage_unavailable')
    return [...new Set(value)].sort()
  }
  async function proof(scope: AccountClosureScope, record: Captured) {
    const prepared = await ports.preparation(scope)
    if (!boundedText(prepared.epoch, 256)) return fail('closure_not_prepared')
    if (record.epoch !== prepared.epoch) return fail('scope_conflict')
    return prepared
  }
  return {
    receipt: {
      put: (input, receipt) => run(input, async scope => {
        await owned(scope, true)
        if (!boundedText(receipt, 65_536)) return fail('invalid_scope')
        const existing = await read(scope)
        await owned(scope, true)
        if (existing) { if (existing.receipt !== receipt) fail('scope_conflict'); return }
        const key = await keyFor(scope, true)
        if (key === null) return fail('closure_storage_unavailable')
        await save({ version: 1, key, receipt, epoch: null, stepNames, next: 0, complete: false, retained: [] })
      }),
      get: input => run(input, async scope => { await owned(scope); return (await required(scope)).receipt }),
      remove: input => run(input, async scope => {
        await owned(scope)
        const record = await required(scope)
        record.receipt = null
        await save(record)
      }),
    },
    bindPreparation: input => run(input, async scope => {
      await owned(scope, true)
      const record = await required(scope)
      if (record.receipt === null || record.complete) return fail('receipt_missing')
      const prepared = await ports.preparation(scope)
      if (!boundedText(prepared.epoch, 256)) return fail('closure_not_prepared')
      if (record.epoch !== null && record.epoch !== prepared.epoch) return fail('scope_conflict')
      record.epoch = prepared.epoch
      await save(record)
    }),
    requireCancelledPreparation: input => run(input, async scope => {
      await owned(scope, true)
      const record = await required(scope)
      if (record.receipt !== null || record.complete) return fail('scope_conflict')
      await proof(scope, record)
      return record.epoch!
    }),
    eraseLocal: input => run<AccountClosureResult>(input, async scope => {
      await owned(scope)
      const record = await required(scope)
      if (record.complete) return { status: 'complete', retainedUnattributed: record.retained }
      if (record.receipt === null) return fail('receipt_missing')
      if (!(await proof(scope, record)).ready) return { status: 'pending', retainedUnattributed: await retained() }
      await ports.beforeErase(scope)
      while (record.next < ports.steps.length) {
        await owned(scope)
        if (!(await ports.steps[record.next]!.run(scope))) return { status: 'pending', retainedUnattributed: await retained() }
        record.next += 1
        await save(record)
      }
      record.retained = await retained()
      record.complete = true
      await save(record)
      return { status: 'complete', retainedUnattributed: record.retained }
    }),
  }
}
