import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteText } from '@gugu/core'
import lockfile from './session/main/lib/proper-lockfile'
import { TeamFundingError } from './team-model-funding'

export interface TeamIssueSlot {
  actorUserId: string
  localTaskId: string | null
  agentUserId: string
  engineId: string
  modelId: string
  protocol: string
  providerSessionId: string | null
  keepFromAccessSessionId: string | null
}
export interface TeamIssueBody {
  action: 'issue'
  agent_user_id: string
  engine_id: string
  model_id: string
  protocol: string
  provider_session_id: string | null
  keep_from_session_id?: string
  team_id: string
  member_identity_id: string
  task_id: string
  expected_membership_revision: number
}
export interface TeamIssueIntent { version: 1; fingerprint: string; idempotency_key: string; body: TeamIssueBody }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const bodyKeys = new Set(['action', 'agent_user_id', 'engine_id', 'model_id', 'protocol', 'provider_session_id', 'keep_from_session_id',
  'team_id', 'member_identity_id', 'task_id', 'expected_membership_revision'])
function fingerprint(slot: TeamIssueSlot) {
  return createHash('sha256').update(JSON.stringify([slot.actorUserId, slot.localTaskId, slot.agentUserId, slot.engineId,
    slot.modelId, slot.protocol, slot.providerSessionId, slot.keepFromAccessSessionId])).digest('hex')
}
function validate(intent: TeamIssueIntent, slot: TeamIssueSlot): TeamIssueIntent {
  const b = intent?.body
  if (intent?.version !== 1 || intent.fingerprint !== fingerprint(slot) || !uuid.test(intent.idempotency_key) || !b
    || b.action !== 'issue' || b.agent_user_id !== slot.agentUserId || b.engine_id !== slot.engineId || b.model_id !== slot.modelId
    || b.protocol !== slot.protocol || b.provider_session_id !== slot.providerSessionId
    || (b.keep_from_session_id ?? null) !== slot.keepFromAccessSessionId || b.member_identity_id !== slot.actorUserId
    || Object.keys(b).some(key => !bodyKeys.has(key))
    || ![b.team_id, b.task_id].every(value => typeof value === 'string' && value.length > 0) || (slot.localTaskId !== null && b.task_id !== slot.localTaskId)
    || !Number.isSafeInteger(b.expected_membership_revision) || b.expected_membership_revision < 0) throw new TeamFundingError('team_identity_required')
  return intent
}

/** A pending HTTP issue keeps its exact body and UUID across retries/restarts. Never stores a token. */
export function createTeamIssueIntentStore(home: string) {
  const directory = join(home, 'team-issue-intents')
  const path = (slot: TeamIssueSlot) => join(directory, `${fingerprint(slot)}.json`)
  async function read(slot: TeamIssueSlot): Promise<TeamIssueIntent | null> {
    try { return validate(JSON.parse(await readFile(path(slot), 'utf8')), slot) }
    catch (cause) { if ((cause as NodeJS.ErrnoException).code === 'ENOENT') return null; throw cause }
  }
  async function locked<T>(slot: TeamIssueSlot, work: (assertOwned: () => void) => Promise<T>): Promise<T> {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    let compromised: Error | undefined
    const release = await lockfile.lock(path(slot), { realpath: false, stale: 30_000, update: 10_000,
      retries: { retries: 80, factor: 1, minTimeout: 50, maxTimeout: 50 }, onCompromised: error => { compromised = error } })
    try { return await work(() => { if (compromised) throw compromised }) }
    finally { await release() }
  }
  return {
    read,
    prepare(slot: TeamIssueSlot, body: TeamIssueBody) {
      return locked(slot, async assertOwned => {
        const existing = await read(slot)
        if (existing) return existing
        // Explicit projection prevents a caller accidentally persisting authentication or response fields.
        const command: TeamIssueBody = { action: 'issue', agent_user_id: body.agent_user_id, engine_id: body.engine_id,
          model_id: body.model_id, protocol: body.protocol, provider_session_id: body.provider_session_id,
          ...(body.keep_from_session_id ? { keep_from_session_id: body.keep_from_session_id } : {}),
          team_id: body.team_id, member_identity_id: body.member_identity_id, task_id: body.task_id,
          expected_membership_revision: body.expected_membership_revision }
        const intent = validate({ version: 1, fingerprint: fingerprint(slot), idempotency_key: randomUUID(), body: command }, slot)
        assertOwned(); await atomicWriteText(path(slot), JSON.stringify(intent)); return intent
      })
    },
    finish(slot: TeamIssueSlot, intent: TeamIssueIntent) {
      return locked(slot, async assertOwned => {
        const current = await read(slot)
        if (!current || current.idempotency_key !== intent.idempotency_key) return
        assertOwned(); await rm(path(slot), { force: true })
      })
    },
  }
}
