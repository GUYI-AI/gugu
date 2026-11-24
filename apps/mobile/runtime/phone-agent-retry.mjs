import { stableId, uuid } from './phone-agent-store.mjs'
import { SessionInputAdmissionError } from '../../../packages/core/src/shared/sessionInputAdmission.ts'

const reject = (code, message) => new SessionInputAdmissionError(message, 'rejected', code)

/** A deliberate retry has one durable child per interrupted attempt. It retains
 * the original destination and data proof, but never copies an approval grant. */
export async function retryInterruptedPhoneJob({ ownerId, store, agent, jobId, admit }) {
  uuid(jobId, 'jobId')
  const original = store.state.jobs[jobId]
  if (!original || original.agentUserId !== agent.agentUserId) throw reject('SESSION_NOT_FOUND', '这条手机任务不存在')
  if ((original.contextEpoch ?? null) !== (agent.contextEpoch ?? null)) throw reject('stale_context', '手机任务上下文已改变，请发送新的任务')
  if (original.status !== 'interrupted') throw reject('invalid_args', '只能重试已中断的手机任务')
  const id = stableId('phone-task-retry', ownerId, agent.sessionId, jobId)
  const existing = store.state.jobs[id]
  if (existing) {
    if (existing.retryOf !== jobId || existing.agentUserId !== agent.agentUserId) throw reject('duplicate_conflict', '重试任务身份不一致')
    await store.save()
  } else {
    const input = { id, agentUserId: agent.agentUserId, clientMessageId: id, retryOf: jobId,
      prompt: original.prompt, route: structuredClone(original.route ?? { kind: 'task', senderUserId: ownerId }) }
    for (const key of ['files', 'annotations', 'contextEpoch', 'inputDataProof', 'usedGroups', 'permissionRequirements', 'usedChatIds']) {
      if (original[key] !== undefined) input[key] = structuredClone(original[key])
    }
    await admit(input)
  }
  return { accepted: true, messageId: id, admission: 'accepted' }
}
