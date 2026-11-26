import type { ArchivedSessionRef, PermanentDeleteOutcome } from '@shared/core/sessions/sessions';

/** WIP: contract only (renderer → main). The implementation lands in the next commit. */
export async function permanentlyDeleteSessions(
  targets: ArchivedSessionRef[],
  options: { withChildren?: boolean } = {}
): Promise<PermanentDeleteOutcome> {
  void options;
  return { deleted: [], unreached: [], failed: targets.map((target) => ({ ...target, reason: 'not implemented yet' })) };
}
