import test from 'node:test'
import assert from 'node:assert/strict'
import { retryInterruptedPhoneJob } from './phone-agent-retry.mjs'
import { admitPhoneJob } from './phone-agent-store.mjs'

const ownerId = '11111111-1111-4111-8111-111111111111'
const agent = { agentUserId: '22222222-2222-4222-8222-222222222222', sessionId: '33333333-3333-4333-8333-333333333333', contextEpoch: 'epoch' }
const jobId = '44444444-4444-4444-8444-444444444444'
function fixture() {
  const original = { id: jobId, agentUserId: agent.agentUserId, contextEpoch: 'epoch', status: 'interrupted', prompt: 'Check the result',
    route: { kind: 'chat', chatId: 'group', sourceMessageId: 'source', senderUserId: ownerId, threadRootId: 'thread', whisper: true },
    inputDataProof: { groups: ['calendar'] }, permissionRequirements: [{ group: 'calendar', permission: 'read' }],
    confirmationResult: { alreadyExecuted: true }, cancelRequested: true }
  const store = { state: { jobs: { [jobId]: original } }, save: async () => undefined }
  const retry = (change = {}) => retryInterruptedPhoneJob({ ownerId, agent, jobId, store, admit: input => admitPhoneJob(store, input), ...change })
  return { store, retry, original }
}
test('reading an interrupted job does not admit work; explicit retry preserves the original route and record', async () => {
  const f = fixture(), before = structuredClone(f.original)
  assert.equal(Object.keys(f.store.state.jobs).length, 1)
  const result = await f.retry()
  assert.equal(result.accepted, true)
  assert.notEqual(result.messageId, jobId)
  assert.deepEqual(f.original, before)
  const child = f.store.state.jobs[result.messageId]
  assert.equal(child.status, 'queued')
  assert.equal(child.retryOf, jobId)
  assert.deepEqual(child.route, before.route)
  assert.deepEqual(child.inputDataProof, before.inputDataProof)
  assert.deepEqual(child.permissionRequirements, before.permissionRequirements)
  assert.equal(child.confirmationResult, undefined)
  assert.equal(child.cancelRequested, undefined)
})
test('parallel taps and a lost reply acknowledge one child, including after that child is interrupted', async () => {
  const f = fixture()
  const replies = await Promise.all([f.retry(), f.retry()])
  assert.equal(replies[0].messageId, replies[1].messageId)
  assert.equal(Object.keys(f.store.state.jobs).length, 2)
  f.store.state.jobs[replies[0].messageId].status = 'interrupted'
  assert.equal((await f.retry()).messageId, replies[0].messageId)
  assert.equal(f.store.state.jobs[replies[0].messageId].status, 'interrupted')
  const next = await f.retry({ jobId: replies[0].messageId })
  assert.equal(f.store.state.jobs[next.messageId].retryOf, replies[0].messageId)
  assert.equal(Object.keys(f.store.state.jobs).length, 3)
})
test('a task from another agent or revoked context cannot be retried', async () => {
  const f = fixture()
  await assert.rejects(f.retry({ agent: { ...agent, agentUserId: ownerId } }), error => error.code === 'SESSION_NOT_FOUND')
  await assert.rejects(f.retry({ agent: { ...agent, contextEpoch: 'revoked' } }), error => error.code === 'stale_context')
  assert.equal(Object.keys(f.store.state.jobs).length, 1)
})
test('ordinary failure and completed execution do not become an interrupted retry', async () => {
  for (const status of ['done', 'failed', 'running', 'queued', 'cancelled']) {
    const f = fixture(); f.original.status = status
    await assert.rejects(f.retry(), error => error.code === 'invalid_args')
    assert.equal(Object.keys(f.store.state.jobs).length, 1)
  }
})
