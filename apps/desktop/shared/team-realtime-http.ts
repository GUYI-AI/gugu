import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { teamAccountTokenHint } from './team-account-claims'
import { verifiedTeamRealtimeScope, type RealtimeIdentityScope } from './team-realtime'

export interface RealtimeIdentityContext { accessToken: string | null; actorUserId: string | null; scope: RealtimeIdentityScope }
const unavailable = () => new Error('Realtime identity is unavailable')
function subject(token: string | null): string | null {
  try {
    if (!token) return null
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')
    const row = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.padEnd(Math.ceil(part.length / 4) * 4, '=')), value => value.charCodeAt(0))))
    return typeof row.sub === 'string' && row.sub ? row.sub : null
  } catch { return null }
}

/** One verified profile cache per account-token provider, shared by that provider's data clients. */
export function createRealtimeIdentityReader(accessToken: () => Promise<string | null>, fetcher: typeof fetch) {
  let cached: { token: string | null; value: RealtimeIdentityContext; until: number } | undefined
  let flight: { token: string | null; promise: Promise<RealtimeIdentityContext> } | undefined
  async function read(force = false): Promise<RealtimeIdentityContext> {
    const token = await accessToken().catch(() => { throw unavailable() })
    if (!force && cached?.token === token && cached.until > Date.now()) return cached.value
    if (flight?.token === token) return flight.promise
    const promise = (async () => {
      const hint = token ? teamAccountTokenHint(token) : 'personal', actorUserId = subject(token)
      if (hint === 'unknown') throw unavailable()
      let scope: RealtimeIdentityScope = { kind: 'personal' }
      if (hint === 'team') {
        if (!actorUserId || !token) throw unavailable()
        const response = await fetcher(`${getSupabaseUrl().replace(/\/$/, '')}/functions/v1/team-accounts?action=profile`, {
          method: 'GET', headers: { apikey: getSupabaseAnonKey(), Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15_000),
        })
        if (!response.ok) throw unavailable()
        const envelope = await response.json(), data = envelope?.data, member = data?.membership
        if (envelope?.ok !== true || member?.identity_id !== actorUserId || member?.state !== 'active'
          || data.membership_revision !== member.revision) throw unavailable()
        scope = verifiedTeamRealtimeScope({ teamId: data.team?.id, memberId: member.id,
          membershipRevision: member.revision, namespace: data.realtime_namespace })
      }
      if (await accessToken() !== token) throw unavailable()
      const value = { accessToken: token, actorUserId, scope }
      cached = { token, value, until: Date.now() + 30_000 }
      return value
    })().catch(() => { if (cached?.token === token) cached = undefined; throw unavailable() })
    flight = { token, promise }
    try { return await promise }
    finally { if (flight?.promise === promise) flight = undefined }
  }
  return { read }
}

/** The protected public RPC returns SQL void (HTTP success with null), not a WebSocket acknowledgement. */
export async function publishTeamRealtimeRpc(fetcher: typeof fetch, accessToken: string,
  args: { p_topic: string; p_payload: unknown; p_event: string }): Promise<{ error: null | Error }> {
  try {
    const response = await fetcher(`${getSupabaseUrl().replace(/\/$/, '')}/rest/v1/rpc/team_publish_realtime`, {
      method: 'POST', headers: { apikey: getSupabaseAnonKey(), Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(args), signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok || (response.status !== 204 && await response.json() !== null)) return { error: unavailable() }
    return { error: null }
  } catch { return { error: unavailable() } }
}
