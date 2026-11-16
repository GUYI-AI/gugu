import { dataClient } from '@/lib/supabase'
import { createTeamApi, type TeamTransport } from './api'
import { TeamApiError } from './errors'
import { getSupabaseAnonKey, getSupabaseUrl } from '@gugu/core/cloud/config'
import { anySignal } from '@gugu/core/shared/anySignal'

const PUBLIC_ACTIONS = new Set(['email_challenge', 'email_verify', 'create', 'sign_in', 'accept_invitation', 'invitation_info', 'google_sign_in'])

/** Existing regional data client publishes the actor token; no second auth refresh loop. */
export const teamHttpTransport: TeamTransport = async ({ endpoint, action, method, body, signal, authorization }) => {
  // Proof/anonymous auth is isolated from the signed-in data client's 401 recovery and session boundary.
  if (endpoint === 'team-accounts' && PUBLIC_ACTIONS.has(action)) {
    const response = await fetch(`${getSupabaseUrl()}/functions/v1/team-accounts`, {
      method: 'POST', headers: { apikey: getSupabaseAnonKey(), 'Content-Type': 'application/json',
        Authorization: authorization ?? `Bearer ${getSupabaseAnonKey()}` },
      body: JSON.stringify({ action, ...body }), signal: anySignal([...(signal ? [signal] : []), AbortSignal.timeout(15_000)]),
    })
    try { return { ...await response.json(), status: response.status } }
    catch { throw new TeamApiError('dependency_unavailable') }
  }
  const query = new URLSearchParams({ action })
  if (method === 'GET') for (const [key, value] of Object.entries(body ?? {})) {
    if (value !== undefined) query.set(key, String(value))
  }
  const name = method === 'GET' ? `${endpoint}?${query}` : endpoint
  const { data, error } = await dataClient.functions.invoke(name, {
    method, signal: anySignal([...(signal ? [signal] : []), AbortSignal.timeout(30_000)]),
    ...(method === 'POST' ? { body: { action, ...body } } : {}),
    ...(authorization ? { headers: { Authorization: authorization } } : {}),
  })
  if (!error) return data
  const response = (error as { context?: Response }).context
  if (response && typeof response.json === 'function') {
    try { return { ...await response.json(), status: response.status } }
    catch { /* Transport diagnostics are not display copy. */ }
  }
  if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
  throw new TeamApiError('dependency_unavailable')
}

export const teamApi = createTeamApi(teamHttpTransport)
