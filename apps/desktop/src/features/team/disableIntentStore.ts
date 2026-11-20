import { TeamApiError } from './errors'

export interface TeamDisableIntent {
  member_id: string
  handoff_member_id?: string
  expected_revision: number
  idempotency_key: string
  operation_id?: string
}
type Storage = Pick<globalThis.Storage, 'getItem' | 'setItem' | 'removeItem'>
const listeners = new Set<() => void>()
const publish = () => { for (const listener of listeners) listener() }
export function subscribeTeamDisableIntents(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener) } }

/** Identifiers only: a lost response/restart must resume the same disablement, never create another handoff. */
export function createTeamDisableIntentStore(storage: Storage, teamId: string, actorId: string, memberId: string) {
  const storageKey = `gugu:team-disable:v1:${encodeURIComponent(teamId)}:${encodeURIComponent(actorId)}:${encodeURIComponent(memberId)}`
  function raw() { try { return storage.getItem(storageKey) } catch { return 'unavailable' } }
  function decode(value: string | null): TeamDisableIntent | null {
    if (value === null) return null
    try {
      const row = JSON.parse(value)
      if (row.version !== 1 || row.team_id !== teamId || row.actor_id !== actorId || row.member_id !== memberId
        || !Number.isSafeInteger(row.expected_revision) || row.expected_revision < 0
        || typeof row.idempotency_key !== 'string' || !row.idempotency_key
        || (row.operation_id !== undefined && typeof row.operation_id !== 'string')
        || (row.handoff_member_id !== undefined && typeof row.handoff_member_id !== 'string')) throw new Error('Invalid receipt')
      return { member_id: memberId, expected_revision: row.expected_revision, idempotency_key: row.idempotency_key,
        ...(row.operation_id ? { operation_id: row.operation_id } : {}), ...(row.handoff_member_id ? { handoff_member_id: row.handoff_member_id } : {}) }
    } catch { throw new TeamApiError('invalid_response') }
  }
  function save(intent: TeamDisableIntent) {
    const value = JSON.stringify({ version: 1, team_id: teamId, actor_id: actorId, member_id: intent.member_id,
      handoff_member_id: intent.handoff_member_id, expected_revision: intent.expected_revision,
      idempotency_key: intent.idempotency_key, operation_id: intent.operation_id })
    decode(value)
    storage.setItem(storageKey, value); publish()
  }
  return {
    raw, decode,
    prepare(command: TeamDisableIntent) {
      const existing = decode(raw())
      if (existing) return existing
      if (command.member_id !== memberId) throw new TeamApiError('invalid_request')
      save(command); return command
    },
    noteOperation(key: string, operationId: string) {
      const intent = decode(raw())
      if (!intent || intent.idempotency_key !== key) throw new TeamApiError('version_conflict')
      save({ ...intent, operation_id: operationId })
    },
    complete(key: string) {
      const intent = decode(raw())
      if (!intent) return
      if (intent.idempotency_key !== key) throw new TeamApiError('version_conflict')
      storage.removeItem(storageKey); publish()
    },
  }
}
