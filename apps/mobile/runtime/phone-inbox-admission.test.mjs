import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile, mkdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openPhoneAgentStore, admitPhoneJob, phoneInboxJobId, stableId } from './phone-agent-store.mjs'

const owner = stableId('owner')
const agentA = stableId('agent', 'a')
const agentB = stableId('agent', 'b')
const source = stableId('source')
const input = (store, agentUserId) => ({
  id: phoneInboxJobId(store, agentUserId, source), agentUserId, prompt: 'authoritative input',
  route: { kind: 'chat', sourceMessageId: source },
})

test('inbox admission is durable per recipient and source, including after a cold restart', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-inbox-store-'))
  try {
    const store = await openPhoneAgentStore(root, owner)
    const [a, b] = await Promise.all([agentA, agentB].map(agent => admitPhoneJob(store, input(store, agent))))
    assert.notEqual(a.id, b.id)
    a.status = 'done'
    b.status = 'running'
    await store.save()
    const cold = await openPhoneAgentStore(root, owner)
    for (const agent of [agentA, agentB]) {
      const retry = input(cold, agent)
      const original = cold.state.jobs[retry.id]
      assert.equal(await admitPhoneJob(cold, { ...retry, prompt: 'duplicate' }), original)
      assert.equal(original.agentUserId, agent)
      assert.equal(original.route.sourceMessageId, source)
      assert.equal(original.prompt, 'authoritative input')
      assert.equal(original.status, agent === agentA ? 'done' : 'interrupted')
    }
    assert.equal(Object.keys(cold.state.jobs).length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('an existing ID owned by another agent is rejected without mutating or acknowledging it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-inbox-conflict-'))
  try {
    const store = await openPhoneAgentStore(root, owner)
    await admitPhoneJob(store, { id: source, agentUserId: agentA, prompt: 'legacy A' })
    const before = await readFile(join(store.directory, 'host.json'), 'utf8')
    await assert.rejects(admitPhoneJob(store, { id: source, agentUserId: agentB, prompt: 'B cannot take A custody' }), /belongs to another agent/)
    assert.equal(await readFile(join(store.directory, 'host.json'), 'utf8'), before)
    assert.equal(Object.keys(store.state.jobs).length, 1)
    assert.notEqual(phoneInboxJobId(store, agentB, source), source)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a same-agent task ID cannot substitute for custody of an inbox source', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-inbox-namespace-'))
  try {
    const store = await openPhoneAgentStore(root, owner)
    await admitPhoneJob(store, { id: source, agentUserId: agentA, prompt: 'task', route: { kind: 'task' } })
    const chat = await admitPhoneJob(store, input(store, agentA))
    assert.notEqual(chat.id, source)
    assert.equal(chat.route.sourceMessageId, source)
    assert.equal(Object.keys(store.state.jobs).length, 2)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test('a second recipient and its retry cannot be acknowledged while its journal save fails', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gugu-inbox-save-'))
  try {
    const store = await openPhoneAgentStore(root, owner)
    const a = await admitPhoneJob(store, input(store, agentA))
    a.status = 'done'
    await store.save()
    const path = join(store.directory, 'host.json')
    const saved = `${path}.saved`
    await rename(path, saved)
    await mkdir(path)
    const bInput = input(store, agentB)
    let acknowledged = 0
    const accept = async () => { const job = await admitPhoneJob(store, bInput); acknowledged++; return job }
    const writeFailed = error => ['EISDIR', 'EPERM', 'ENOTEMPTY'].includes(error.code)
    await assert.rejects(accept(), writeFailed)
    await assert.rejects(accept(), writeFailed)
    assert.equal(acknowledged, 0)
    assert.equal(store.state.jobs[a.id].status, 'done')
    const original = store.state.jobs[bInput.id]
    await rm(path, { recursive: true })
    await rename(saved, path)
    assert.equal(await accept(), original)
    assert.equal(acknowledged, 1)
    const cold = await openPhoneAgentStore(root, owner)
    assert.equal(cold.state.jobs[bInput.id].agentUserId, agentB)
    assert.equal(cold.state.jobs[a.id].status, 'done')
  } finally { await rm(root, { recursive: true, force: true }) }
})
