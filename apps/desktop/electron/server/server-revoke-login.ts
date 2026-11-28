import { egress } from '@gugu/core/shared/egress'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { readFileSync } from 'node:fs'
import { atomicWriteText } from '@gugu/core/local/state/paths'
import { clearStoredServerSession, readStoredServerSession, reserveSessionSlot, writeStoredServerSession, type ServerSessionTokens } from './server-auth'

function sessionId(token: string, userId: string): string {
  const claims = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as { sub?: unknown; session_id?: unknown }
  if (claims.sub !== userId || typeof claims.session_id !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.session_id)
    || claims.session_id === '00000000-0000-0000-0000-000000000000') {
    throw new Error('The stored login does not identify this account and server session')
  }
  return claims.session_id
}

async function errorCode(response: Response): Promise<unknown> {
  return (await response.json().catch(() => null) as { error_code?: unknown } | null)?.error_code
}

type RevokeLoginDeps = {
  read: () => ServerSessionTokens | null
  reserve: () => void
  write: (tokens: ServerSessionTokens) => void
  clear: () => void | Promise<void>
  request: (path: string, headers: Record<string, string>, body?: string) => Promise<Response>
}

/** Run after the server has stopped so that only this process can rotate the stored login. */
export async function revokeServerLogin(userId: string, deps: RevokeLoginDeps): Promise<void> {
  const stored = deps.read()
  if (!stored) throw new Error('The stored server login is missing')
  const id = sessionId(stored.accessToken, userId)
  const logout = async (token: string) => {
    const response = await deps.request('logout?scope=local', { authorization: `Bearer ${token}` })
    if (response.status === 204) return true
    const code = await errorCode(response)
    // GoTrue verifies the access token before checking the session named in its claims.
    if (response.status === 403 && code === 'session_not_found') return true
    if (response.status === 403 && code === 'bad_jwt') return false
    throw new Error(`Server sign-out failed (HTTP ${response.status})`)
  }
  if (!(await logout(stored.accessToken))) {
    deps.reserve()
    const response = await deps.request('token?grant_type=refresh_token', { 'content-type': 'application/json' },
      JSON.stringify({ refresh_token: stored.refreshToken }))
    if (!response.ok) throw new Error(`Could not refresh the server login (HTTP ${response.status})`)
    const body = await response.json() as { access_token?: unknown; refresh_token?: unknown }
    if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string'
      || sessionId(body.access_token, userId) !== id) throw new Error('Refreshed login did not identify the same server session')
    const tokens = { accessToken: body.access_token, refreshToken: body.refresh_token }
    deps.write(tokens)
    if (!(await logout(tokens.accessToken))) throw new Error('The authentication service rejected the refreshed server access token')
  }
  await deps.clear()
}

export async function revokeStoredServerLogin(userId: string, archiveReceipt: string): Promise<void> {
  const archived = readFileSync(archiveReceipt, 'utf8')
  const revoked = userId + '\nrevoked\n'
  if (archived !== revoked && archived !== userId + '\n') throw new Error('Task archival was not confirmed for this account')
  const { stopRegisteredSystemdService } = await import('./server-service')
  stopRegisteredSystemdService()
  if (readFileSync(archiveReceipt, 'utf8') !== archived) throw new Error('The server restarted after task archival')
  if (archived === revoked) return clearStoredServerSession()
  const base = getSupabaseUrl().replace(/\/$/, '')
  const apikey = getSupabaseAnonKey()
  await revokeServerLogin(userId, {
    read: readStoredServerSession,
    reserve: reserveSessionSlot,
    write: writeStoredServerSession,
    clear: async () => {
      await atomicWriteText(archiveReceipt, revoked)
      clearStoredServerSession()
    },
    request: (path, headers, body) => egress.fetch(`${base}/auth/v1/${path}`, {
      method: 'POST', headers: { apikey, ...headers }, body, timeoutMs: 10_000,
    }),
  })
}
