import { VaultError, type CredentialReference, type VaultCode } from './contracts'
import type { VaultFeatureOperation } from './feature-guard'
import type { ManagementRuntime } from './management'
import { deleteCredential, editCredential, mutationResult, saveCredential } from './management'
import { createInput, editInput, editMetadata, entrySummary, referenceSchema } from './management-model'
import type { VaultCreateInput, VaultEditPatch, VaultManagementPort, VaultMutationGuard, VaultMutationOutcome } from './management-contract'
import { uuid } from './schema'

export interface ManagementHost {
  person(actor: object): void
  queryActor(actor: object): void
  run<T>(action: () => Promise<T>): Promise<T>
  withFeature<T>(feature: VaultFeatureOperation, action: () => Promise<T>): Promise<T>
  gates(): Promise<void>
  feature(signal: AbortSignal, current: () => unknown): Promise<VaultFeatureOperation>
  open(cleanup: Promise<boolean>, feature?: VaultFeatureOperation, entryWrite?: () => void): ManagementRuntime & { release(): void }
  revoke(reference: CredentialReference | undefined, reason: 'edit' | 'delete'): { cleanup: Promise<boolean>; release(): void }
  protect(clear: () => void): () => void
  fail(reason?: VaultCode): Promise<void>
}
const code = (error: unknown): VaultCode => error instanceof VaultError ? error.code : 'STORAGE_FAILED'
function clearInput(value: VaultCreateInput | VaultEditPatch): void {
  value.account = ''; value.password = ''
  for (const field of value.fields ?? []) field.value = ''
  if ('addFields' in value) for (const field of value.addFields ?? []) field.value = ''
}
function requestGuard(host: ManagementHost, person: object, guard: VaultMutationGuard) {
  host.person(person)
  const signal = guard?.signal
  if (!(signal instanceof AbortSignal) || typeof guard.assertCurrent !== 'function') throw new VaultError('UNAVAILABLE')
  const assertion = guard.assertCurrent.bind(guard)
  const current = () => {
    host.person(person)
    if (signal.aborted) throw new VaultError('CANCELLED')
    const result: unknown = assertion()
    if (result !== undefined) { void Promise.resolve(result).catch(() => undefined); throw new VaultError('UNAVAILABLE') }
    if (signal.aborted) throw new VaultError('CANCELLED')
  }
  current()
  return { signal, current }
}

/** Fixed native-local port: shares the vault queue, key, revocation and encrypted operation ledger. */
export function createManagementPort(host: ManagementHost): VaultManagementPort {
  async function mutate(person: object, operationId: string, action: 'create' | 'edit' | 'delete',
    body: VaultCreateInput | VaultEditPatch | undefined, original: CredentialReference | undefined, guard: VaultMutationGuard): Promise<VaultMutationOutcome> {
    let input: VaultCreateInput | VaultEditPatch | undefined, release: () => void = () => undefined, detach: () => void = () => undefined
    let revocation: ReturnType<ManagementHost['revoke']> | undefined, entryPossible = false, ledgerKnown = false
    const failureResult = async (failure: VaultCode): Promise<VaultMutationOutcome> => {
      if (!entryPossible && !ledgerKnown && uuid.safeParse(operationId).success) {
        try {
          const status = await read(person, true, runtime => runtime.payload.operations.find(item => item.id === operationId)?.status)
          entryPossible = status === 'committed'; ledgerKnown = true
        } catch { /* An unreadable ledger cannot prove that this request never committed. */ }
      }
      return { status: entryPossible || !ledgerKnown && uuid.safeParse(operationId).success ? 'uncertain' : 'not_committed', code: failure }
    }
    try {
      const request = requestGuard(host, person, guard)
      if (!uuid.safeParse(operationId).success) throw new VaultError('INVALID_INPUT')
      const parsed = original === undefined ? undefined : referenceSchema.safeParse(original)
      if (parsed && !parsed.success) throw new VaultError('INVALID_INPUT')
      const reference = parsed?.success ? parsed.data : undefined
      if (action !== 'create' && !reference) throw new VaultError('INVALID_INPUT')
      input = action === 'create' ? createInput(body as VaultCreateInput) : action === 'edit' ? editInput(body as VaultEditPatch) : undefined
      const clear = () => { if (input) clearInput(input) }
      release = host.protect(clear)
      request.signal.addEventListener('abort', clear, { once: true }); detach = () => request.signal.removeEventListener('abort', clear)
      request.current()
      revocation = host.revoke(reference, action === 'delete' ? 'delete' : 'edit')
      const outcome = await host.run<VaultMutationOutcome>(async () => {
        let runtime: ReturnType<ManagementHost['open']> | undefined, feature: VaultFeatureOperation | undefined
        try {
          request.current(); const held = feature = await host.feature(request.signal, request.current)
          held.onInvalidate(clear)
          return await host.withFeature(held, async () => {
            await held.wait(() => host.gates())
            runtime = host.open(revocation!.cleanup, held, () => { entryPossible = true })
            entryPossible = runtime.payload.operations.some(operation => operation.id === operationId && operation.status === 'committed')
            ledgerKnown = true
            if (action === 'create') await saveCredential(runtime, operationId, input as VaultCreateInput)
            else if (action === 'edit') await editCredential(runtime, operationId, reference!, input as VaultEditPatch)
            else await deleteCredential(runtime, operationId, reference!)
            held.assertCurrent()
            const operation = runtime.payload.operations.find(item => item.id === operationId)!
            return { status: 'committed', result: mutationResult(operation, runtime.epoch) } as const
          })
        } catch (error) {
          const failure = code(error)
          if (feature?.writeStarted || ['STORAGE_FAILED', 'AUDIT_FAILED', 'DATA_DAMAGED'].includes(failure)) await host.fail(failure === 'UNAVAILABLE' || failure === 'CANCELLED' ? 'STORAGE_FAILED' : failure)
          return { status: entryPossible ? 'uncertain' : 'not_committed', code: failure }
        } finally { runtime?.release(); feature?.release() }
      })
      return outcome.status === 'committed' ? outcome : await failureResult(outcome.code)
    } catch (error) { return await failureResult(error instanceof VaultError ? error.code : 'INVALID_INPUT') }
    finally { detach(); revocation?.release(); release(); if (input) clearInput(input) }
  }
  async function read<T>(actor: object, personOnly: boolean, project: (runtime: ManagementRuntime) => T): Promise<T> {
    const assertActor = personOnly ? host.person : host.queryActor
    assertActor(actor)
    return host.run(async () => {
      assertActor(actor); await host.gates(); assertActor(actor)
      const runtime = host.open(Promise.resolve(true))
      try { runtime.current(); const value = project(runtime); runtime.current(); return value }
      finally { runtime.release() }
    })
  }
  const port: VaultManagementPort = {
    query: actor => read(actor, false, runtime => runtime.payload.credentials.map(value => entrySummary(value, runtime.epoch))),
    describeEdit: (person, reference) => read(person, true, runtime => {
      const parsed = referenceSchema.safeParse(reference)
      if (!parsed.success) throw new VaultError('INVALID_INPUT')
      return editMetadata(runtime.check(parsed.data), parsed.data)
    }),
    create: (person, id, input, guard) => mutate(person, id, 'create', input, undefined, guard),
    edit: (person, id, reference, patch, guard) => mutate(person, id, 'edit', patch, reference, guard),
    delete: (person, id, reference, guard) => mutate(person, id, 'delete', undefined, reference, guard),
    operationResult: (person, id) => read(person, true, runtime => {
      if (!uuid.safeParse(id).success) throw new VaultError('INVALID_INPUT')
      const operation = runtime.payload.operations.find(item => item.id === id)
      return !operation ? { status: 'unknown' } : operation.status === 'pending' ? { status: 'pending' }
        : { status: 'committed', result: mutationResult(operation, runtime.epoch) }
    }),
  }
  return Object.freeze(port)
}
