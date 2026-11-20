import { parseTeamInvitationLink } from '../../../shared/team-invitation-link'
import { TeamApiError } from './errors'
import * as read from './readers'
import type { TeamInvitation, TeamInvitationReceipt } from './types'

const states = new Set(['pending', 'sending', 'accepted', 'failed', 'unknown'])
const nullableId = (value: unknown) => value === null ? null : read.text(value, 'operation_id')

export function readInvitationReceipt(value: unknown): TeamInvitationReceipt {
  const row = read.object(value, 'invitation receipt'), delivery = read.object(row.delivery, 'delivery')
  if (![true, false, null].includes(row.invitation_created as boolean | null) || typeof delivery.state !== 'string' || !states.has(delivery.state)
    || (delivery.state === 'accepted' && row.invitation_created !== true)
    || (delivery.reason_code !== null && (typeof delivery.reason_code !== 'string' || !/^[a-z0-9_]{1,100}$/.test(delivery.reason_code)))) {
    throw new TeamApiError('invalid_response')
  }
  return { operation_id: nullableId(row.operation_id), invitation_created: row.invitation_created as boolean | null,
    delivery: { operation_id: nullableId(delivery.operation_id), state: delivery.state as TeamInvitationReceipt['delivery']['state'], reason_code: delivery.reason_code as string | null } }
}

export function readInvitation(value: unknown): TeamInvitation {
  const row = read.object(value, 'invitation'), receipt = readInvitationReceipt(row)
  if (row.state !== 'invited' || receipt.invitation_created !== true || !receipt.operation_id) throw new TeamApiError('invalid_response')
  const links = read.object(row.app_deep_links, 'app_deep_links'), invitationUrl = read.text(row.invitation_url, 'invitation_url')
  try {
    const web = new URL(invitationUrl)
    if (web.protocol !== 'https:' || web.username || web.password || web.pathname !== '/team/invite') throw new Error('Invalid invitation route')
    const expected = parseTeamInvitationLink(`gugu://team/invite${web.search}${web.hash}`)
    if (!expected) throw new Error('Invalid invitation capability')
    for (const [name, scheme] of [['stable', 'gugu:'], ['beta', 'gugu-beta:'], ['dev', 'gugu-dev:']] as const) {
      const raw = read.text(links[name], 'invitation deep link'), link = parseTeamInvitationLink(raw)
      if (!link || new URL(raw).protocol !== scheme || link.token !== expected.token || link.region !== expected.region) throw new Error('Inconsistent invitation links')
    }
  } catch { throw new TeamApiError('invalid_response') }
  return { ...receipt, operation_id: receipt.operation_id, invitation_created: true,
    invitation_id: read.text(row.invitation_id, 'invitation_id'), state: 'invited', expires_at: read.text(row.expires_at, 'expires_at'),
    invitation_url: invitationUrl, app_deep_links: { stable: links.stable as string, beta: links.beta as string, dev: links.dev as string } }
}

// Capabilities must never become enumerable Error fields or diagnostics. Only this feature can read them.
const failures = new WeakMap<object, { receipt: TeamInvitationReceipt; invitation: TeamInvitation | null }>()
export function captureInvitationFailure(error: TeamApiError, value: unknown) {
  if (value === null || value === undefined) return
  try {
    const receipt = readInvitationReceipt(value)
    let invitation: TeamInvitation | null = null
    if (receipt.invitation_created === true) { try { invitation = readInvitation(value) } catch { /* No verified links in this partial receipt. */ } }
    failures.set(error, { receipt, invitation })
  } catch { /* Untrusted/malformed receipt stays unknown; its original intent remains pending. */ }
}
export const invitationFailure = (error: unknown) => error && typeof error === 'object' ? failures.get(error) : undefined
