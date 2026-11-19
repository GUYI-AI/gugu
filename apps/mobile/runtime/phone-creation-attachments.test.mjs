import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openPhoneAgentStore, admitPhoneJob } from './phone-agent-store.mjs'
import { createPhoneProvisioner } from './phone-agent-provision.mjs'
import { createPhoneTaskApi } from './phone-agent-task-api.mjs'
import { createPhoneAttachmentCreation } from './phone-creation-attachments.mjs'

const createChannel = 'sessionTimeline.sessionCreateAttachmentDraft'
const admitChannel = 'sessionTimeline.sessionAdmitCreatedAttachments'

async function fixture(root, ownerId = randomUUID()) {
  const store = await openPhoneAgentStore(root, ownerId)
  const agent = Object.values(store.state.agents)[0] ?? { agentUserId: randomUUID(), sessionId: randomUUID(), chatId: randomUUID(), status: 'idle' }
  store.state.agents[agent.agentUserId] = agent
  await store.save()
  const calls = { provisions: 0, admissions: 0, resolutions: 0 }
  const manifest = { id: 'photo', name: 'photo.png', sizeBytes: 12, mimeType: 'image/png', sha256: 'a'.repeat(64) }
  const request = { clientRequestId: randomUUID(), initialMessageId: randomUUID(), harness: 'pi', prompt: '', attachments: [manifest] }
  const file = { itemId: randomUUID(), version: 1, name: manifest.name, sizeBytes: 12, mimeType: manifest.mimeType }
  const provisionRow = { id: 'provision', operation_id: 'operation', agent_user_id: agent.agentUserId, create_command_id: 'command', phase: 'ready' }
  const cloud = {
    identity: { from: table => ({ select: () => ({ eq: () => ({ single: async () => ({ data: table === 'agent_provisions' ? provisionRow : { status: 'done' }, error: null }) }) }) }) },
    rpc: async (_schema, name) => {
      if (name === 'start_agent_provision_operation') { calls.provisions++; return {} }
      if (name === 'settle_agent_provision_terminal') return provisionRow
      if (name === 'complete_agent_provision') return {}
      throw new Error(`Unexpected formal RPC ${name}`)
    },
  }
  const provision = createPhoneProvisioner({ ownerId, deviceId: 'phone', workspaceId: 'project', root, cloud, store,
    models: { resolve: async () => 'model' }, tick: async () => {}, publish() {},
    // The ordinary creator must not admit a caption in this mode.
    admit: async () => { throw new Error('Deferred creation admitted input before placement') },
    snapshot: a => ({ session_id: a.sessionId, title: 'Phone task' }),
  })
  const api = createPhoneTaskApi({ ownerId, store, findSession: id => { assert.equal(id, agent.sessionId); return agent }, verifyAgent: async () => {},
    admit: async input => { calls.admissions++; await admitPhoneJob(store, input) },
  })
  const dependencies = {
    ownerId, deviceId: 'phone', store, isReady: () => true,
    provision: async input => {
      // The manifest is already in the real host journal before a formal provisioning RPC.
      const disk = JSON.parse(await readFile(join(store.directory, 'host.json'), 'utf8'))
      assert.deepEqual(disk.attachmentCreations[input.clientRequestId].request.attachments, input.attachments)
      const created = await provision(input.clientRequestId, input, null, null, { deferFirstInput: true })
      return { conversationId: created.session_id, projectId: 'project', title: created.title,
        attachmentTarget: { agentUserId: agent.agentUserId, chatId: agent.chatId } }
    },
    task: async id => { assert.equal(id, agent.sessionId); return agent }, verify: async () => {},
    resolve: async (_agent, ref) => {
      calls.resolutions++
      return { agentUserId: agent.agentUserId, chatId: agent.chatId, itemId: ref.itemId, version: ref.version,
        sizeBytes: manifest.sizeBytes, sha256: manifest.sha256 }
    },
    send: async input => (await api('sessionTimeline.sessionSend', [input], randomUUID())).value,
  }
  const invoke = createPhoneAttachmentCreation(dependencies)
  const admission = { conversationId: agent.sessionId, clientRequestId: request.clientRequestId,
    initialMessageId: request.initialMessageId, placements: [{ attachmentId: manifest.id, file }] }
  return { ownerId, store, agent, calls, request, admission, dependencies, invoke }
}

async function isolated(run) {
  const root = await mkdtemp(join(tmpdir(), 'phone-create-attachments-'))
  try { await run(root) } finally { await rm(root, { recursive: true, force: true }) }
}

test('file-only creation durably owns the manifest, returns its actual target, and queues no caption', () => isolated(async root => {
  const fx = await fixture(root)
  const { value } = await fx.invoke(createChannel, [fx.request])
  assert.equal(value.attachmentDraft.state, 'awaiting-placement')
  assert.deepEqual(value.attachmentTarget, { agentUserId: fx.agent.agentUserId, chatId: fx.agent.chatId })
  assert.equal(Object.keys(fx.store.state.jobs).length, 0)
  assert.equal(fx.calls.admissions, 0)
  assert.deepEqual((await fx.invoke(createChannel, [fx.request])).value, value)
  assert.equal(fx.calls.provisions, 1)
}))

test('verified placement admits one stable real job; restart and duplicate preserve the original task and input', () => isolated(async root => {
  const fx = await fixture(root)
  await fx.invoke(createChannel, [fx.request])
  const result = await fx.invoke(admitChannel, [fx.admission])
  assert.equal(result.value.attachmentDraft.state, 'admitted')
  const jobs = Object.values(fx.store.state.jobs)
  assert.equal(jobs.length, 1)
  assert.equal(jobs[0].clientMessageId, fx.request.initialMessageId)
  assert.equal(jobs[0].prompt, '')
  assert.equal(jobs[0].requiresCompleteFiles, true)
  assert.deepEqual(jobs[0].expectedFileDigests, [{ itemId: fx.admission.placements[0].file.itemId, version: 1,
    sha256: fx.request.attachments[0].sha256, sizeBytes: 12 }])
  const restarted = await openPhoneAgentStore(root, fx.ownerId)
  const dependencies = { ...fx.dependencies, store: restarted,
    provision: async () => { throw new Error('A restored created task must not be provisioned again') },
    send: async input => {
      const api = createPhoneTaskApi({ ownerId: fx.ownerId, store: restarted,
        verifyAgent: async () => { throw new Error('An accepted input must not be re-enqueued') },
      })
      return (await api('sessionTimeline.sessionSend', [input])).value
    },
  }
  const replay = createPhoneAttachmentCreation(dependencies)
  assert.deepEqual(await replay(createChannel, [fx.request]), result)
  assert.deepEqual(await replay(admitChannel, [fx.admission]), result)
  assert.equal(Object.keys(restarted.state.jobs).length, 1)
  assert.equal(fx.calls.admissions, 1)
}))

test('a lost admission reply is recovered from the real job before re-resolving a subsequently revoked file', () => isolated(async root => {
  const fx = await fixture(root)
  let lose = true
  const original = fx.dependencies.send
  const invoke = createPhoneAttachmentCreation({ ...fx.dependencies, send: async input => {
    const result = await original(input)
    if (lose) { lose = false; throw new Error('reply lost after durable admission') }
    return result
  } })
  await invoke(createChannel, [fx.request])
  await assert.rejects(invoke(admitChannel, [fx.admission]), /reply lost/)
  assert.equal(fx.calls.admissions, 1)
  const replay = createPhoneAttachmentCreation({ ...fx.dependencies,
    resolve: async () => { throw Object.assign(new Error('access later revoked'), { code: 'EACCES' }) },
  })
  assert.equal((await replay(admitChannel, [fx.admission])).value.attachmentDraft.state, 'admitted')
  assert.equal(fx.calls.admissions, 1)
}))

test('an unavailable final file preserves the creation and admits no partial caption', () => isolated(async root => {
  const fx = await fixture(root)
  fx.request.attachments.push({ ...fx.request.attachments[0], id: 'second' })
  fx.admission.placements.push({ attachmentId: 'second', file: { ...fx.admission.placements[0].file, itemId: randomUUID() } })
  let reads = 0
  const invoke = createPhoneAttachmentCreation({ ...fx.dependencies, resolve: async (...args) => {
    if (++reads === 2) throw new Error('last file still uploading')
    return fx.dependencies.resolve(...args)
  } })
  await invoke(createChannel, [fx.request])
  await assert.rejects(invoke(admitChannel, [fx.admission]), /last file still uploading/)
  assert.equal(fx.calls.admissions, 0)
  assert.equal(Object.keys(fx.store.state.jobs).length, 0)
  assert.equal(fx.store.state.attachmentCreations[fx.request.clientRequestId].created.conversationId, fx.agent.sessionId)
}))

test('a real journal write refusal stops provisioning and a repaired journal retries the same intent', () => isolated(async root => {
  const fx = await fixture(root)
  const path = join(fx.store.directory, 'host.json')
  await rename(path, `${path}.original`); await mkdir(path)
  await assert.rejects(fx.invoke(createChannel, [fx.request]))
  assert.equal(fx.calls.provisions, 0)
  await rm(path, { recursive: true }); await rename(`${path}.original`, path)
  const created = await fx.invoke(createChannel, [fx.request])
  assert.equal(created.value.conversationId, fx.agent.sessionId)
  assert.equal(fx.calls.provisions, 1)
}))

test('changed intent, task, target, or owner cannot reuse the original creation', () => isolated(async root => {
  const fx = await fixture(root)
  await fx.invoke(createChannel, [fx.request])
  await assert.rejects(fx.invoke(createChannel, [{ ...fx.request, prompt: 'changed' }]), /intent cannot be changed/)
  await assert.rejects(fx.invoke(admitChannel, [{ ...fx.admission, conversationId: randomUUID() }]), /original registered/)
  fx.agent.chatId = randomUUID()
  await assert.rejects(fx.invoke(admitChannel, [fx.admission]), /target changed/)
  assert.throws(() => createPhoneAttachmentCreation({ ...fx.dependencies, ownerId: randomUUID() }), /another owner/)
  assert.equal(fx.calls.admissions, 0)
}))

test('a sign-out during the complete placement read cannot admit into the stopped owner host', () => isolated(async root => {
  const fx = await fixture(root)
  let ready = true
  const invoke = createPhoneAttachmentCreation({ ...fx.dependencies, isReady: () => ready,
    resolve: async (...args) => { const fact = await fx.dependencies.resolve(...args); ready = false; return fact },
  })
  await invoke(createChannel, [fx.request])
  await assert.rejects(invoke(admitChannel, [fx.admission]), /no longer ready/)
  assert.equal(fx.calls.admissions, 0)
  assert.equal(Object.keys(fx.store.state.jobs).length, 0)
}))

test('sign-out while the prepared record is being saved stops before send and preserves its task', () => isolated(async root => {
  const fx = await fixture(root)
  let ready = true, entered, release
  const saving = new Promise(resolve => { entered = resolve })
  const resume = new Promise(resolve => { release = resolve })
  const save = fx.store.save.bind(fx.store)
  fx.store.save = async () => {
    await save()
    const entry = fx.store.state.attachmentCreations?.[fx.request.clientRequestId]
    if (entry?.prepared && !entry.admitted) { entered(); await resume }
  }
  const invoke = createPhoneAttachmentCreation({ ...fx.dependencies, isReady: () => ready })
  const created = await invoke(createChannel, [fx.request])
  const sending = invoke(admitChannel, [fx.admission])
  await saving; ready = false; release()
  await assert.rejects(sending, /no longer ready/)
  assert.equal(fx.calls.admissions, 0)
  assert.equal(fx.store.state.attachmentCreations[fx.request.clientRequestId].created.conversationId, created.value.conversationId)
}))
