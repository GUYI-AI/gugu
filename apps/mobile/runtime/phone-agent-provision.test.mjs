import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createPhoneProvisioner } from './phone-agent-provision.mjs'
import { readDeliveryEnvelope } from '../../../packages/core/src/local/agent/deliveryEnvelope.ts'
import { parseComposerCard } from '../../../packages/core/src/shared/ui/taskCardModels.ts'

const ownerId = '8aa10e91-2d5f-4b8a-bf46-70154795a118'
const agentId = '59c63835-7f9b-463b-9576-7b54ee14f031'
const callerId = 'ec6d81f5-d25f-4414-8a0a-017b4979e186'
const groupId = '830db16e-b2d5-4272-b363-b6600596a3ec'
const topicId = 'aa3205aa-3815-4c18-9da6-d16839f60143'
const otherTopicId = '6bdc74a7-ce1b-4138-9d6a-ce5b59e8bb61'

function fixture(status, { failAdmitOnce = false, revoked = false } = {}) {
  const calls = []
  const admitted = [], cards = new Map(), saved = []
  const agent = { agentUserId: agentId, sessionId: 'child-session', chatId: 'child-dm', displayName: 'Phone Agent' }
  const store = { state: { requests: {}, agents: { [agentId]: agent } }, save: async () => {} }
  store.save = async () => { saved.push(structuredClone(store.state)) }
  const provisionRow = { agent_user_id: agentId, create_command_id: 'create-command', phase: 'ready' }
  const rooms = new Map([
    [groupId, { id: groupId, kind: 'group', status: 'active', public_id: 42, name: 'Source', source_chat_id: null }],
    [topicId, { id: topicId, kind: 'topic', status: 'active', public_id: 43, name: 'Chosen topic', source_chat_id: groupId }],
    [otherTopicId, { id: otherTopicId, kind: 'topic', status: 'active', public_id: 44, name: 'Another topic', source_chat_id: groupId }],
  ])
  const query = (table) => {
    const filters = {}
    const value = () => {
      if (table === 'chats') return filters.id ? rooms.get(filters.id) ?? null : [...rooms.values()].find(room => room.public_id === filters.public_id) ?? null
      if (table === 'active_members') return filters.chat_id === groupId && ['joined', 'already_member'].includes(status) ? { user_id: agentId } : null
      if (table === 'users') return { id: agentId, avatar: null }
      if (table === 'agent_provisions') return provisionRow
      if (table === 'gugu_device_commands') return { status: 'done' }
      throw new Error(`Unexpected table ${table}`)
    }
    const q = { select: () => q, eq: (key, entry) => { filters[key] = entry; return q }, single: async () => ({ data: value(), error: null }), maybeSingle: async () => ({ data: value(), error: null }) }
    return q
  }
  const cloud = {
    chat: { from: query }, identity: { from: query },
    rpc: async (schema, name, args) => {
      calls.push([schema, name, args])
      if (name === 'start_agent_provision_operation' || name === 'complete_agent_provision') return {}
      if (name === 'settle_agent_provision_terminal') return provisionRow
      if (name === 'chat_facts') return rooms.get(args.p_chat_id) ?? null
      if (name === 'send_message_idempotent') {
        const card = { id: args.p_message_id, chat_id: args.p_chat_id, content: args.p_content }
        cards.set(card.id, cards.get(card.id) ?? card)
        return [cards.get(card.id)]
      }
      if (name === 'add_group_agent') {
        // Model the installed backend's required actor and task-aware signature.
        if (!args.p_as_user_id || !Object.hasOwn(args, 'p_as_task')) throw new Error('RPC signature mismatch')
        if (status === 'denied') throw new Error('member_limit_reached')
        return { chat_id: groupId, status }
      }
      throw new Error(`Unexpected RPC ${schema}.${name}`)
    },
  }
  const provision = createPhoneProvisioner({ ownerId, cloud, store, deviceId: 'phone-device',
    projectId: 'phone-project', root: '/phone-private', models: { resolve: async () => 'free' },
    tick: async () => {}, admit: async (input) => {
      admitted.push(structuredClone(input))
      if (failAdmitOnce && admitted.length === 1) throw new Error('simulated admission disconnect')
    }, publish: () => {}, machineLabel: () => 'Test phone',
    resolveIdentities: async () => new Map([[ownerId, { displayName: 'Owner', guguNumber: 1 }]]),
    authorize: async () => { if (revoked) throw new Error('phone data permission revoked') },
    snapshot: (entry) => ({ agent_user_id: entry.agentUserId, birth_group: entry.birthGroup }),
  })
  return { provision, calls, agent, admitted, cards, store, saved, rooms }
}

for (const status of ['joined', 'pending_approval']) {
  for (const caller of [null, { agentUserId: callerId, sessionId: 'parent-session', deviceId: 'phone-device', name: 'Parent' }]) {
    test(`birth-group ${status} uses the ${caller ? 'calling agent' : 'authenticated owner'} as actor`, async () => {
      const fx = fixture(status)
      const action = { harness: 'pi', prompt: 'Create one phone task', chatId: groupId }
      const first = await fx.provision('request-1043', action, caller)
      assert.deepEqual(fx.calls.filter(([, name]) => name === 'add_group_agent'), [[
        'chat', 'add_group_agent', {
          p_chat_id: groupId, p_agent_user_id: agentId, p_message: null,
          p_as_user_id: caller?.agentUserId ?? ownerId, p_as_task: true,
        },
      ]])
      assert.deepEqual(first.birth_group, { chatId: groupId, status })
      assert.deepEqual(await fx.provision('request-1043', action, caller), first)
      assert.equal(fx.calls.filter(([, name]) => name === 'add_group_agent').length, 1)
    })
  }
}

test('a denied birth-group request remains failed rather than claiming membership', async () => {
  const fx = fixture('denied')
  await fx.provision('denied-1043', { prompt: 'Create task', chatId: groupId })
  assert.deepEqual(fx.agent.birthGroup, { chatId: groupId, status: 'failed', error: 'member_limit_reached' })
})

test('creation outside a group does not request membership', async () => {
  const fx = fixture('joined')
  await fx.provision('no-group-1043', { prompt: 'Create task' })
  assert.equal(fx.calls.some(([, name]) => name === 'add_group_agent'), false)
  assert.equal(fx.agent.birthGroup, undefined)
})

test('a phone topic task lands one card and admits a reply addressed to that topic', async () => {
  const fx = fixture('joined')
  const action = { prompt: 'Do this in the chosen topic', chatId: groupId, taskChatId: topicId }
  const result = await fx.provision('topic-task', action)
  assert.match(result.task_message_id, /^[0-9a-f-]{36}$/)
  assert.equal(fx.cards.size, 1)
  const card = fx.cards.get(result.task_message_id)
  assert.equal(card.chat_id, topicId)
  assert.deepEqual(parseComposerCard(card.content), { v: 1, type: 'task', text: action.prompt,
    agentUserId: agentId, agentName: 'Phone Agent', agentType: 'pi', agentAvatar: null,
    sessionId: 'child-session', projectId: 'phone-project', deviceId: 'phone-device', machineLabel: 'Test phone' })
  const turn = fx.admitted[0]
  assert.equal(turn.id, result.task_message_id)
  assert.deepEqual(turn.route, { kind: 'chat', chatId: topicId, sourceMessageId: result.task_message_id, senderUserId: ownerId })
  const envelope = readDeliveryEnvelope(turn.prompt).segments[0].facts
  assert.equal(envelope.chat, '43')
  assert.equal(envelope.chatKind, 'topic')
  assert.equal(envelope.messageId, `msg:${result.task_message_id}`)
  assert.deepEqual(await fx.provision('topic-task', action), result)
  assert.equal(fx.admitted.length, 1)
})

test('retry after a landed card reuses the persisted first turn and stable message id', async () => {
  const fx = fixture('joined', { failAdmitOnce: true })
  const action = { prompt: 'Retry the same topic task', chatId: groupId, taskChatId: topicId }
  await assert.rejects(fx.provision('topic-retry', action), /disconnect/)
  await new Promise(resolve => setTimeout(resolve, 5))
  const result = await fx.provision('topic-retry', action)
  assert.equal(fx.cards.size, 1)
  assert.deepEqual(fx.admitted[0], fx.admitted[1])
  assert.equal(fx.admitted[1].id, result.task_message_id)
  assert.ok(fx.saved.some(state => state.requests['topic-retry']?.initialTurn?.id === result.task_message_id))
})

test('a durable phone creation cannot switch topic on retry', async () => {
  const fx = fixture('joined')
  const action = { prompt: 'Fixed task destination', chatId: groupId, taskChatId: topicId }
  await fx.provision('fixed-topic', action)
  await assert.rejects(fx.provision('fixed-topic', { ...action, taskChatId: otherTopicId }), /不能更换/)
  assert.equal(fx.cards.size, 1)
})

test('an unrelated or archived topic is rejected before provisioning an agent', async () => {
  for (const changed of [{ source_chat_id: otherTopicId }, { status: 'archived' }]) {
    const fx = fixture('joined')
    Object.assign(fx.rooms.get(topicId), changed)
    await assert.rejects(fx.provision('bad-topic', { prompt: 'Task', chatId: groupId, taskChatId: topicId }), /来源|有效|话题/)
    assert.equal(fx.calls.some(([, name]) => name === 'start_agent_provision_operation'), false)
    assert.equal(fx.admitted.length, 0)
  }
})

test('a pending group join lands the card without asking the agent to send without permission', async () => {
  const fx = fixture('pending_approval')
  const result = await fx.provision('pending-topic', { prompt: 'Wait for the group', chatId: groupId, taskChatId: topicId })
  assert.equal(fx.cards.size, 1)
  assert.equal(result.birth_group.status, 'pending_approval')
  assert.equal(fx.admitted[0].route.kind, 'task')
  assert.match(fx.admitted[0].prompt, /等待|审批/)
})

test('a dispatched task retains input data proof and cannot publish a card after revocation', async () => {
  const action = { prompt: 'Task carrying phone data', chatId: groupId, taskChatId: topicId }
  const proof = { groups: ['calendar'], permissionRequirements: [{ permissions: ['READ_CALENDAR'] }] }
  const fx = fixture('joined')
  await fx.provision('proof-topic', action, null, proof)
  assert.deepEqual(fx.admitted[0].inputDataProof, proof)
  const denied = fixture('joined', { revoked: true })
  await assert.rejects(denied.provision('revoked-topic', action, null, proof), /revoked/)
  assert.equal(denied.cards.size, 0)
  assert.equal(denied.admitted.length, 0)
})
