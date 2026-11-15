import assert from 'node:assert/strict'
import test from 'node:test'
import { createPhoneChatAccess, phoneChatReadTools } from './phone-agent-chat.mjs'
import { randomUUID } from 'node:crypto'

const self = '10000000-0000-4000-8000-000000000001'
const other = '10000000-0000-4000-8000-000000000002'
const chat = '10000000-0000-4000-8000-000000000003'

function memberTool(presence) {
  const users = [{ id: self, display_name: '手机 Agent', type: 'agent' }, { id: other, display_name: '远端 Agent', type: 'agent' }]
  const cloud = {
    identity: { from: () => ({ select: () => ({ in: async (_column, ids) => ({ data: users.filter((user) => ids.includes(user.id)) }) }) }) },
    rpc: async (schema, method, args) => {
      if (schema === 'chat' && method === 'list_member_ids') {
        assert.equal(args.p_as_user_id, self)
        return users.map((user) => ({ user_id: user.id }))
      }
      assert.equal(schema, 'identity')
      assert.equal(method, 'get_agent_presence_batch')
      assert.deepEqual(args.p_agent_user_ids, [other])
      return presence()
    },
  }
  return phoneChatReadTools({ agent: { agentUserId: self }, cloud, store: { state: { agents: { [self]: { status: 'idle' } } } }, env: { GUGU_HOME: '/tmp/gugu-phone-chat-unit' } }).find((tool) => tool.name === 'message_members')
}

test('member discovery survives presence failure and retains typed addressing plus local status', async () => {
  const tool = memberTool(() => { throw new Error('presence unavailable') })
  const { details } = await tool.execute('read-members', { chat_id: chat })
  assert.equal(details.total, 2)
  assert.match(details.status_unavailable, /presence unavailable/)
  assert.equal(details.items.find((item) => item.is_self).status_from, 'this_machine')
  assert.equal(details.items.find((item) => !item.is_self).user_id, `user:${other}`)
})

test('unknown remote device state stays unknown in member directory', async () => {
  const tool = memberTool(() => ({ results: { [other]: { status: 'presence', presence: { agent_status: 'idle', device_status: null } } } }))
  const { details } = await tool.execute('read-members', { chat_id: chat })
  assert.equal(details.items.find((item) => !item.is_self).host_online, null)
})

const source = '10000000-0000-4000-8000-000000000004'

function writeAccess({ sourceMembers = [self, other], topicMembers = [other], visible = true, kind = 'topic', sourceId = source, rules = '' } = {}) {
  const calls = []
  const cloud = { rpc: async (schema, method, args) => {
    assert.equal(schema, 'chat')
    assert.equal(args.p_as_user_id, self)
    calls.push([method, args.p_chat_id])
    if (method === 'list_member_ids') return (args.p_chat_id === source ? sourceMembers : topicMembers).map(user_id => ({ user_id }))
    if (method === 'chat_facts') return !visible ? [] : [{ kind: args.p_chat_id === source ? 'group' : kind, source_chat_id: args.p_chat_id === source ? null : sourceId, group_prompt: args.p_chat_id === source ? rules : null }]
    throw new Error(`unexpected ${method}`)
  } }
  return { calls, access: createPhoneChatAccess({ agent: { agentUserId: self }, cloud, store: { state: {} }, env: { GUGU_HOME: `/tmp/phone-topic-write-${randomUUID()}` } }) }
}

test('a source-group member can make its first topic reply without a pre-existing topic seat', async () => {
  const { access, calls } = writeAccess()
  await access.beforeWrite(chat, [other])
  assert.ok(calls.some(([method, id]) => method === 'list_member_ids' && id === source))
})

test('a topic participant cannot retain write authority after losing its source-group seat', async () => {
  const { access } = writeAccess({ sourceMembers: [other], topicMembers: [self, other] })
  await assert.rejects(access.beforeWrite(chat, [other]), /不是.*成员/)
})

test('topic access rejects an unreadable destination and a missing source', async () => {
  await assert.rejects(writeAccess({ visible: false }).access.beforeWrite(chat), /权限|可见/)
  await assert.rejects(writeAccess({ sourceId: null }).access.beforeWrite(chat), /来源/)
})

test('a first topic reply still requires reading inherited group rules', async () => {
  const { access } = writeAccess({ rules: 'Do not publish credentials.' })
  await assert.rejects(access.beforeWrite(chat, [other]), /message_rules/)
})

test('topic recipients must belong to the source and ordinary group membership is still required', async () => {
  await assert.rejects(writeAccess().access.beforeWrite(chat, ['outside']), /收件人/)
  await assert.rejects(writeAccess({ kind: 'group' }).access.beforeWrite(chat, [other]), /不是.*成员/)
})
