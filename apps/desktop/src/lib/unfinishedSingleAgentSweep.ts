// #3160: startup may finish an already completed creation; only a person may resume or cancel one.
import type { AgentProvision, AgentProvisionOperation } from '@gugu/core/shared/types/agentProvision'
import type { CreateAgentOnDeviceResult } from '@gugu/core/shared/types/chat'
import { assertResumeRecordOwner, completedSingleProvisionSession, defaultResumeStore, getProvision, getProvisionOperation, resumeSingleAgent, type ProvisionResumeRecord, type ProvisionResumeStore } from './agentProvision'
import { getCurrentAuthUserId } from './supabase'
import { clearCancelledStarter } from './starterContinuation'
import { cancelTeamProvision, type CancelTeamProvisionResult } from './teamProvisionSaga'
import type { CleanupStage } from './cleanupStageCopy'

export type UnfinishedSingleAgentOutcome =
  | { operationId: string; kind: 'discarded' }
  | { operationId: string; kind: 'cancelled'; warningStages: CleanupStage[] }
  | { operationId: string; kind: 'completed'; session: CreateAgentOnDeviceResult }
  | { operationId: string; kind: 'pending'; stages: CleanupStage[]; error?: string }

export interface UnfinishedSingleAgentSweepDeps {
  store?: ProvisionResumeStore
  getOperation?: (operationId: string) => Promise<AgentProvisionOperation | null>
  cancel?: (operationId: string) => Promise<CancelTeamProvisionResult>
  getMember?: (provisionId: string) => Promise<AgentProvision | null>
  getOwnerUserId?: () => Promise<string>
  resume?: typeof resumeSingleAgent
  clearStarter?: typeof clearCancelledStarter
}

async function assertOwner(record: ProvisionResumeRecord, deps: UnfinishedSingleAgentSweepDeps) {
  await assertResumeRecordOwner(record, deps.getOwnerUserId ?? getCurrentAuthUserId, 'single')
}

async function finish(record: ProvisionResumeRecord, operation: AgentProvisionOperation, deps: UnfinishedSingleAgentSweepDeps): Promise<UnfinishedSingleAgentOutcome> {
  const member = record.members[0]
  if (!member) throw new Error(`resume record ${record.operationId} has no member ref`)
  const row = await (deps.getMember ?? getProvision)(member.provisionId)
  if (!row) throw new Error(`single provision ${member.provisionId} missing although operation completed`)
  const session = completedSingleProvisionSession({ operationId: record.operationId, provisionId: member.provisionId, operation, outcome: { member: row } })
  await assertOwner(record, deps)
  ;(deps.store ?? defaultResumeStore).forget(record.ownerUserId, record.operationId)
  return { operationId: record.operationId, kind: 'completed', session }
}

/** Read once on startup. Absence, errors and unfinished phases preserve the person's intent. */
export async function sweepUnfinishedSingleAgents(ownerUserId: string, deps: UnfinishedSingleAgentSweepDeps = {}): Promise<UnfinishedSingleAgentOutcome[]> {
  const outcomes: UnfinishedSingleAgentOutcome[] = []
  for (const record of (deps.store ?? defaultResumeStore).list(ownerUserId)) {
    if (record.blueprint.kind !== 'single') continue
    const { operationId } = record
    try {
      await assertOwner(record, deps)
      const operation = await (deps.getOperation ?? getProvisionOperation)(operationId)
      outcomes.push(operation?.phase === 'completed'
        ? await finish(record, operation, deps)
        : { operationId, kind: 'pending', stages: [] })
    } catch (error) {
      outcomes.push({ operationId, kind: 'pending', stages: [], error: error instanceof Error ? error.message : String(error) })
    }
  }
  return outcomes
}

function singleRecord(ownerUserId: string, operationId: string, deps: UnfinishedSingleAgentSweepDeps): ProvisionResumeRecord {
  const record = (deps.store ?? defaultResumeStore).list(ownerUserId).find(item => item.operationId === operationId && item.blueprint.kind === 'single')
  if (!record) throw new Error('Unfinished agent creation is no longer available')
  return record
}

/** Visible Continue action: original ids, owner and source verification. */
export async function continueUnfinishedSingleAgent(ownerUserId: string, operationId: string, deps: UnfinishedSingleAgentSweepDeps = {}): Promise<UnfinishedSingleAgentOutcome> {
  const record = singleRecord(ownerUserId, operationId, deps)
  await assertOwner(record, deps)
  const operation = await (deps.getOperation ?? getProvisionOperation)(operationId)
  if (operation?.phase === 'completed') return finish(record, operation, deps)
  const result = await (deps.resume ?? resumeSingleAgent)(record, { resumeStore: deps.store, getOwnerUserId: deps.getOwnerUserId })
  await assertOwner(record, deps)
  if (result.operation.phase === 'completed') return finish(record, result.operation, deps)
  return { operationId, kind: 'pending', stages: [] }
}

/** Called only after the existing confirmation dialog. Completion wins the cancellation race. */
export async function deleteUnfinishedSingleAgent(ownerUserId: string, operationId: string, deps: UnfinishedSingleAgentSweepDeps = {}): Promise<UnfinishedSingleAgentOutcome> {
  const record = singleRecord(ownerUserId, operationId, deps)
  await assertOwner(record, deps)
  const operation = await (deps.getOperation ?? getProvisionOperation)(operationId)
  await assertOwner(record, deps)
  if (!operation) {
    await (deps.clearStarter ?? clearCancelledStarter)(operationId, deps.getOwnerUserId)
    await assertOwner(record, deps)
    ;(deps.store ?? defaultResumeStore).forget(ownerUserId, operationId)
    return { operationId, kind: 'discarded' }
  }
  if (operation.phase === 'completed') return finish(record, operation, deps)
  const cancel = deps.cancel ?? ((id: string) => cancelTeamProvision(id, { resumeStore: deps.store, getOwnerUserId: deps.getOwnerUserId }))
  const result = await cancel(operationId)
  if (result.operation.phase === 'completed') return finish(record, result.operation, deps)
  if (result.fullyCancelled) {
    await assertOwner(record, deps)
    ;(deps.store ?? defaultResumeStore).forget(ownerUserId, operationId)
    return { operationId, kind: 'cancelled', warningStages: result.cleanupErrors.map(item => item.stage) }
  }
  return { operationId, kind: 'pending', stages: result.cleanupErrors.map(item => item.stage) }
}
