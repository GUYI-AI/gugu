export interface VerifiedTeamRealtimeScope {
  kind: 'team'
  namespace: string
  membershipRevision: number
}
export type RealtimeIdentityScope = { kind: 'personal' } | VerifiedTeamRealtimeScope

/** The complete namespace comes from the authenticated profile, never a requested team ID. */
export function verifiedTeamRealtimeScope(input: { teamId: string; memberId: string; membershipRevision: number; namespace: unknown }): VerifiedTeamRealtimeScope {
  const invalidNamespace = typeof input.namespace !== 'string' || !input.namespace
    || [...input.namespace].some(character => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  if (!input.teamId || !input.memberId || !Number.isSafeInteger(input.membershipRevision) || input.membershipRevision < 0
    || invalidNamespace) throw new Error('Verified team realtime namespace is unavailable')
  return { kind: 'team', namespace: input.namespace as string, membershipRevision: input.membershipRevision }
}

export function identityRealtimeTopic(scope: RealtimeIdentityScope, topic: string): string {
  if (!topic) throw new Error('Realtime topic is empty')
  return scope.kind === 'personal' ? topic : `${scope.namespace}${topic}`
}
export function identityRealtimeOptions<T extends { config?: { private?: boolean } }>(scope: RealtimeIdentityScope, options: T): T {
  return scope.kind === 'personal' ? options : { ...options, config: { ...options.config, private: true } }
}
export function realtimeScopeChanged(previous: RealtimeIdentityScope, next: RealtimeIdentityScope): boolean {
  return previous.kind !== next.kind || (previous.kind === 'team' && next.kind === 'team'
    && (previous.namespace !== next.namespace || previous.membershipRevision !== next.membershipRevision))
}
