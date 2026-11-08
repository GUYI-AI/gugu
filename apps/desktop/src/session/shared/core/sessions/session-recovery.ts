/** A missing engine session can be replaced unless it is a legacy shell, created without a first utterance. */
export function canStartFreshSession(errorKind: string | null | undefined, firstUtterance: string | undefined): boolean {
  return errorKind === 'provider_session_missing' && Boolean(firstUtterance);
}
