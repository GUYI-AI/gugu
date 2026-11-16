import { TeamApiError } from './errors'
import { readInvitationReceipt } from './invitation-receipt'
import type { TeamInvitationReceipt } from './types'

type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
export interface TeamInviteIntent { email: string; role: 'member'; idempotency_key: string; receipt: TeamInvitationReceipt | null }
const listeners = new Set<() => void>()
export const subscribeInviteIntents = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } }
const publish = () => { for (const listener of listeners) listener() }
const canonical = (email: string) => email.trim().toLowerCase()
const validEmail = (email: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)

/** Original commands and safe receipts only. Capability links never enter this store. */
export function createTeamInviteIntentStore(storage: Storage, teamId: string, actorId: string, newKey: () => string = () => crypto.randomUUID()) {
  const scope = `gugu:team-invite:v1:${encodeURIComponent(teamId)}:${encodeURIComponent(actorId)}`
  const recordKey = (email: string) => `${scope}:${encodeURIComponent(canonical(email))}`
  const activeKey = `${scope}:active`
  function raw(email: string) { try { return email ? storage.getItem(recordKey(email)) : null } catch { return 'unavailable' } }
  function decode(value: string | null, email: string): TeamInviteIntent | null {
    if (value === null) return null
    try {
      const row = JSON.parse(value)
      if (row.version !== 1 || row.team_id !== teamId || row.actor_id !== actorId || row.role !== 'member'
        || typeof row.email !== 'string' || !validEmail(row.email) || row.email !== row.email.trim()
        || canonical(row.email) !== canonical(email) || typeof row.idempotency_key !== 'string'
        || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(row.idempotency_key)) throw new Error('Invalid invitation command')
      return { email: row.email, role: 'member', idempotency_key: row.idempotency_key,
        receipt: row.receipt === null ? null : readInvitationReceipt(row.receipt) }
    } catch { throw new TeamApiError('invitation_storage_unavailable') }
  }
  function save(command: TeamInviteIntent) {
    const value = JSON.stringify({ version: 1, team_id: teamId, actor_id: actorId,
      email: command.email, role: 'member', idempotency_key: command.idempotency_key,
      receipt: command.receipt === null ? null : readInvitationReceipt(command.receipt) })
    decode(value, command.email)
    try { storage.setItem(recordKey(command.email), value) } catch { throw new TeamApiError('invitation_storage_unavailable') }
    publish()
  }
  return {
    raw, decode,
    active() {
      try {
        const email = storage.getItem(activeKey)
        if (email === null) return null
        const command = decode(raw(email), email)
        if (!command) throw new Error('Missing active command')
        return command
      } catch { throw new TeamApiError('invitation_storage_unavailable') }
    },
    prepare(email: string) {
      if (!teamId || !actorId || !validEmail(email.trim())) throw new TeamApiError('invalid_request')
      const existing = decode(raw(email), email)
      const command = existing ?? { email: email.trim(), role: 'member' as const, idempotency_key: newKey(), receipt: null }
      if (!existing) save(command)
      try { storage.setItem(activeKey, canonical(command.email)) } catch { throw new TeamApiError('invitation_storage_unavailable') }
      return command
    },
    noteReceipt(email: string, key: string, value: TeamInvitationReceipt) {
      const command = decode(raw(email), email), next = readInvitationReceipt(value)
      if (!command || command.idempotency_key !== key) throw new TeamApiError('version_conflict')
      const previous = command.receipt
      if (previous?.operation_id && next.operation_id && previous.operation_id !== next.operation_id
        || previous?.delivery.operation_id && next.delivery.operation_id && previous.delivery.operation_id !== next.delivery.operation_id) throw new TeamApiError('invalid_response')
      save({ ...command, receipt: { ...next, operation_id: next.operation_id ?? previous?.operation_id ?? null,
        invitation_created: previous?.invitation_created === true ? true : next.invitation_created ?? previous?.invitation_created ?? null,
        delivery: !next.delivery.operation_id && previous?.delivery.operation_id ? previous.delivery : next.delivery } })
    },
    acknowledge(email: string, key: string) {
      const command = decode(raw(email), email)
      if (!command || command.idempotency_key !== key || command.receipt?.invitation_created !== true || command.receipt.delivery.state !== 'accepted') return
      try { if (storage.getItem(activeKey) === canonical(email)) storage.removeItem(activeKey) }
      catch { throw new TeamApiError('invitation_storage_unavailable') }
      // The per-email command remains, so reopening that invitation cannot generate another key.
      publish()
    },
  }
}
