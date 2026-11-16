export interface VerifiedTeamRealtimeScope {
  kind: 'team'
  namespace: string
  membershipRevision: number
}
export type RealtimeIdentityScope = { kind: 'personal' } | VerifiedTeamRealtimeScope
export const TEAM_REALTIME_CONTEXT_CHANGED = 'gugu:team-context-changed'

/** The complete namespace comes from the authenticated profile, never a requested team ID. */
export function verifiedTeamRealtimeScope(input: { teamId: string; memberId: string; membershipRevision: number; namespace: unknown }): VerifiedTeamRealtimeScope {
  const invalidNamespace = typeof input.namespace !== 'string' || !input.namespace
    || [...input.namespace].some(character => /\s/.test(character) || character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  if (typeof input.teamId !== 'string' || !input.teamId || typeof input.memberId !== 'string' || !input.memberId || !Number.isSafeInteger(input.membershipRevision) || input.membershipRevision < 0
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

type Broadcast = { type: 'broadcast'; event: string; payload: unknown }
type PublishPorts = {
  sendPersonal: (message: Broadcast) => PromiseLike<unknown>
  rpc: (name: 'team_publish_realtime', args: { p_topic: string; p_payload: unknown; p_event: string }) => PromiseLike<{ error: unknown }>
}

/** Team writes never use a cached WebSocket permission. The server resolves all recipient namespaces. */
export async function publishIdentityRealtimeBroadcast(scope: RealtimeIdentityScope, originalTopic: string, message: Broadcast, ports: PublishPorts) {
  if (scope.kind === 'personal') return ports.sendPersonal(message)
  if (scope.kind !== 'team' || !originalTopic || message.type !== 'broadcast' || !message.event) throw new Error('Team realtime publication was refused')
  try {
    const result = await ports.rpc('team_publish_realtime', { p_topic: originalTopic, p_payload: message.payload, p_event: message.event })
    if (result.error !== null) throw new Error('Refused')
    return 'ok'
  } catch { throw new Error('Team realtime publication was refused') }
}
