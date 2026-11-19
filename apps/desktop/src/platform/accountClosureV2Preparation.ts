import type { AccountClosureV2Native } from './accountClosureV2'

/** Platform publication barrier around the one native-led execution flow. */
export function withAccountClosureV2Preparation(native: AccountClosureV2Native, pauseOwner: (ownerId: string) => Promise<void>): AccountClosureV2Native {
  return {
    ...native,
    async prepare(handle) {
      const original = await native.discover()
      if (!original || Object.keys(handle).length !== 3 || original.handle.localOperationId !== handle.localOperationId
        || original.handle.nativeGeneration !== handle.nativeGeneration || original.handle.localRevision !== handle.localRevision) {
        throw Object.assign(new Error('Account closure operation changed before preparation'), { code: 'scope_conflict' })
      }
      if (original.recoveryOnly) throw Object.assign(new Error('Original account closure requires recovery'), { code: 'closure_recovery_required' })
      await pauseOwner(original.ownerId)
      return native.prepare(handle)
    },
  }
}
