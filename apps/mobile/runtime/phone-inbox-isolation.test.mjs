import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { startPhoneAgentHost } from './phone-agent-host.mjs'
import { openPhoneAgentStore } from './phone-agent-store.mjs'

const ownerId = '68a158dd-1832-4671-ac02-ebde330d3d7a'
const installId = '22a953e8-e021-4789-9fc9-e41ecb37295b'
const deviceId = `phone-${installId}-${ownerId}`
const agentId = '558fcc98-9d61-4054-8a18-900d969b1849'
const chatId = 'a540c592-971b-4bcf-89c3-944484a14640'
const groupId = '0c44ad9d-8fed-4285-ab8c-469c91101cf6'

function fakeCloud() {
  const commands = []
  const calls = []
  const messages = []
  const notices = []
  const inboxRows = []
  const devices = []
  const users = [{ id: agentId, type: 'agent', owner_user_id: ownerId, device_id: deviceId, display_name: '手机 Agent', desired_status: 'online' }, { id: ownerId, type: 'human', display_name: '主人' }]
  let provision
  const identity = {
    rpc: async (name, args) => {
      calls.push([name, args])
      if (name === 'fetch_fair_pending_device_commands') return { data: commands.filter((command) => command.status === 'pending'), error: null }
      if (name === 'recheck_device_command_execution') return { data: true, error: null }
      if (name === 'recover_orphaned_device_commands') return { data: 0, error: null }
      return { data: {}, error: null }
    },
    from: (table) => {
      let filters = []
      let patch
      const result = () => {
        if (table === 'active_users') return { data: users.filter((entry) => filters.every(([key, value]) => Array.isArray(value) ? value.includes(entry[key]) : entry[key] === value)), error: null }
        if (table === 'gugu_devices') {
          const matching = devices.filter((device) => filters.every(([key, value]) => device[key] === value))
          if (patch) { calls.push(['update_device', { patch, filters }]); for (const device of matching) Object.assign(device, patch) }
          return { data: matching, error: null }
        }
        if (table === 'chats') return { data: [{ id: groupId, kind: 'group', status: 'active' }], error: null }
        if (table === 'active_members') return { data: [], error: null }
        if (table === 'agent_provisions') return { data: provision, error: null }
        if (table === 'gugu_device_commands') {
          const matching = commands.filter((command) => filters.every(([key, value]) => command[key] === value))
          if (patch) for (const command of matching) Object.assign(command, patch)
          return { data: matching, error: null }
        }
        throw new Error(`unexpected table ${table}`)
      }
      const query = {
        insert: async (row) => {
          if (table !== 'messages') throw new Error(`unexpected insert into ${table}`)
          if (!notices.some((notice) => notice.id === row.id)) notices.push(structuredClone(row))
          return { data: null, error: null }
        },
        upsert: async (row) => {
          calls.push(['upsert_device', row])
          const existing = devices.find((device) => device.device_id === row.device_id)
          if (existing) Object.assign(existing, structuredClone(row))
          else devices.push(structuredClone(row))
          return { data: null, error: null }
        },
        select: () => query,
        update: (value) => { patch = value; return query },
        eq: (key, value) => { filters.push([key, value]); return query },
        in: (key, value) => { filters.push([key, value]); return query },
        order: () => query,
        single: async () => { const answer = result(); return { ...answer, data: Array.isArray(answer.data) ? answer.data[0] : answer.data } },
        maybeSingle: async () => { const answer = result(); return { ...answer, data: Array.isArray(answer.data) ? answer.data[0] ?? null : answer.data } },
        then: (success, failure) => Promise.resolve(result()).then(success, failure),
      }
      return query
    },
  }
  const cloud = {
    identity, chat: { from: identity.from }, root: 'https://test.invalid', client: {},
    start: async () => undefined, close: async () => undefined, configure: async () => undefined, token: async () => 'test-token',
    modelAccess: async (body) => {
      calls.push(['model-access', body])
      if (body.action === 'catalog') return { models: [{ id: 'free', display_name: 'Test model', enabled: true, protocols: ['openai-chat-completions'] }] }
      if (body.action === 'issue') return { session_id: randomUUID(), relay_url: 'https://model.invalid/v1', token: 'private-turn-token', model: 'model-alias', protocol: 'openai-chat-completions', expires_at: new Date(Date.now() + 600_000).toISOString() }
      return {}
    },
    rpc: async (schema, name, args) => {
      calls.push([name, args])
      if (name === 'start_agent_provision_operation') {
        provision ??= { ...args.p_blueprint.members[0], id: args.p_blueprint.members[0].provision_id, operation_id: args.p_operation_id, member_key: 'single', device_id: deviceId, phase: 'queued', project_path: null, avatar: null, special_focus: null }
        return { id: args.p_operation_id }
      }
      if (name === 'claim_provision_slots') { if (provision.phase !== 'queued') return []; provision.phase = 'preparing'; return [provision] }
      if (name === 'prepare_agent_provision') {
        const commandId = randomUUID()
        provision = { ...provision, phase: 'awaiting_terminal', agent_user_id: agentId, dm_chat_id: chatId, create_command_id: commandId }
        commands.push({ id: commandId, type: 'agent.create', status: 'pending', created_at: new Date().toISOString(), payload: { agent_user_id: agentId, display_name: '手机 Agent', agent_type: 'pi', greeting_chat_id: chatId, model: 'platform:free' } })
        return provision
      }
      if (name === 'settle_agent_provision_terminal') { assert.equal(commands.find((command) => command.id === provision.create_command_id).status, 'done'); provision.phase = 'ready'; return provision }
      if (name === 'complete_agent_provision') { assert.equal(provision.phase, 'ready'); provision.phase = 'completed'; return { already: false } }
      if (name === 'pull_agent_inbox_v2') return inboxRows
      if (name === 'mark_read_on_deliver') { inboxRows.splice(inboxRows.findIndex((row) => row.id === args.p_message_id), 1); return {} }
      if (name === 'chat_facts') return [{ kind: 'dm', group_prompt: null, source_chat_id: null }]
      if (name === 'list_member_ids') return [{ user_id: agentId }, { user_id: ownerId }]
      if (name === 'add_group_agent') return { chat_id: args.p_chat_id, status: 'pending_approval' }
      if (name === 'send_message_idempotent') { if (!messages.some((message) => message.p_message_id === args.p_message_id)) messages.push(args); return [{ id: args.p_message_id }] }
      throw new Error(`unexpected ${schema} RPC ${name}`)
    },
  }
  return { cloud, commands, calls, messages, notices, inboxRows, devices, users }
}

async function fixture(runTurn, { nativeCall = async () => ({ ok: true }), cancelTurn = () => true, actionFactory = async () => ({ tools: () => [], confirmationForMessage: () => null, cancel: async () => undefined }), prepare = async () => undefined, onRpcStart = () => undefined, onSessionReply = () => undefined, preparationOptions = {} } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-phone-host-'))
  const previousHome = process.env.GUGU_AGENT_HOME
  process.env.GUGU_AGENT_HOME = root
  const fake = fakeCloud()
  const events = []
  const sessionReplies = []
  let authChanged
  let connectivityChanged
  const config = { ownerId, deviceId, installId, supabaseUrl: 'https://test.invalid', supabaseAnonKey: 'public', accessToken: 'private', refreshToken: 'private', grants: { calendar: true, photos: true }, deviceRow: { device_id: deviceId, user_id: ownerId, label: '测试手机', hostname: 'test-phone', platform: 'android', capabilities: { actions: { v: 1, actions: [] } } } }
  await prepare({ root, ...fake, events })
  const host = await startPhoneAgentHost(config, {
    runTurn, cancelTurn, emit: (event) => events.push(event), nativeCall, preparationOptions,
    cloudFactory: (_config, onSession) => { authChanged = onSession; return fake.cloud },
    actionFactory,
    resolveIdentities: async () => new Map([[ownerId, { displayName: '主人', guguNumber: 1, isAgent: false }], [agentId, { displayName: '手机 Agent', guguNumber: 2, isAgent: true }]]),
    rpcFactory: async (handlers) => {
      connectivityChanged = handlers.onConnectivity
      await onRpcStart({ ...handlers, events, ...fake })
      return { close: async () => undefined, requester: {
        call: async (_device, _type, body) => {
          if (body.channel === 'agentSession.locate') return { result: { value: { session_ids: body.args[1].session_ids } } }
          sessionReplies.push(body)
          await onSessionReply(body)
          return { result: { value: { recipients: [{ to: `session:${body.args[1].session_ids[0]}`, status: 'delivered', message_id: randomUUID() }] } } }
        },
      } }
    },
  })
  return { ...fake, root, config, host, events, sessionReplies, authChanged: (...args) => authChanged(...args), connectivityChanged: (connected) => connectivityChanged(connected), async close() { await host.close(); if (previousHome === undefined) delete process.env.GUGU_AGENT_HOME; else process.env.GUGU_AGENT_HOME = previousHome; await rm(root, { recursive: true }) } }
}
const until = async (predicate, events) => {
  const deadline = Date.now() + 5_000
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`expected turn did not settle: ${JSON.stringify(events.filter((event) => ['turn_failed', 'host_log'].includes(event.type)))}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const recipientB = '74521d22-4a6e-4909-81d9-e9c62bf43205'
const sourceId = '26acc8d3-d040-4334-a6ee-77cbb3cdb6f9'

for (const legacyStatus of [null, 'done', 'running']) for (const lostAckForA of [false, true]) test(`same group source has independent custody (legacy=${legacyStatus}, lost A ACK=${lostAckForA})`, async () => {
  const receipts = []
  const pending = new Set([agentId, recipientB])
  let readJournal
  let failAck = lostAckForA
  const turns = []
  const fx = await fixture(async command => { turns.push(command.sessionId); return { status: 'done', text: '[NO_REPLY]' } }, {
    prepare: async ({ root, users, cloud }) => {
      readJournal = async () => JSON.parse(await readFile(join(root, 'hosts', ownerId, 'host.json'), 'utf8'))
      const store = await openPhoneAgentStore(root, ownerId)
      for (const id of [agentId, recipientB]) {
        if (!users.some(user => user.id === id)) users.push({ ...users[0], id })
        store.state.agents[id] = { agentUserId: id, ownerId, deviceId, sessionId: randomUUID(), displayName: 'Target fixture', chatId, modelId: 'free', status: 'idle' }
      }
      if (legacyStatus) store.state.jobs[sourceId] = { id: sourceId, agentUserId: agentId, prompt: 'original legacy input', route: { kind: 'chat', chatId: groupId, sourceMessageId: sourceId, senderUserId: ownerId }, status: legacyStatus, createdAt: new Date().toISOString() }
      await store.save()
      const rpc = cloud.rpc
      cloud.rpc = async (schema, name, args) => {
        if (name === 'chat_facts') return [{ kind: 'group', group_prompt: null, source_chat_id: null }]
        if (name === 'list_member_ids') return [ownerId, agentId, recipientB].map(user_id => ({ user_id }))
        if (name === 'pull_agent_inbox_v2') return pending.has(args.p_agent_user_id) ? [{
          chat_id: groupId, chat_kind: 'group', chat_public_id: 2240, id: sourceId, seq: 1,
          sender_user_id: ownerId, sender_type: 'human', sender_display_name: 'Owner',
          content: 'Each recipient must independently receive this group message.', content_type: 'text',
          to_user_ids: [agentId, recipientB], is_whisper: false, file_item_id: null, file_version: null,
          file_blob_id: null, group_rules: 'Each addressed agent handles its own delivery.', named_identities: {}, created_at: '2026-11-08T05:47:00.000Z',
        }] : []
        if (name === 'mark_read_on_deliver') {
          const saved = await readJournal()
          receipts.push({ target: args.p_user_id, source: args.p_message_id,
            custody: Object.values(saved.jobs).filter(job => job.agentUserId === args.p_user_id && job.route?.sourceMessageId === sourceId).map(job => job.id),
            failed: failAck && args.p_user_id === agentId })
          if (failAck && args.p_user_id === agentId) throw new Error('simulated target A ACK loss')
          pending.delete(args.p_user_id)
          return {}
        }
        return rpc(schema, name, args)
      }
    },
  })
  try {
    const journal = await readJournal()
    const jobs = Object.values(journal.jobs).filter(job => job.route?.sourceMessageId === sourceId)
    assert.deepEqual(jobs.map(job => job.agentUserId).sort(), [agentId, recipientB].sort(), JSON.stringify({ jobs, receipts, warnings: fx.events.filter(event => event.type === "host_log" && event.level === "warn") }))
    assert.equal(new Set(jobs.map(job => job.id)).size, 2, 'each target has its own durable job identity')
    assert.ok(receipts.every(receipt => receipt.custody.length === 1), 'no target is ACKed using another target job: ' + JSON.stringify(receipts))
    assert.deepEqual([...new Set(receipts.map(receipt => receipt.target))].sort(), [agentId, recipientB].sort())
    assert.ok(receipts.every(receipt => receipt.source === sourceId), 'ACK preserves the authoritative source message UUID')
    assert.equal(pending.has(recipientB), false, 'target B independently commits its receipt')
    assert.equal(pending.has(agentId), lostAckForA, 'target B cannot commit target A unread cursor')
    await until(async () => Object.values((await readJournal()).jobs).every(job => ['done', 'interrupted'].includes(job.status)), fx.events)
    const completed = await readJournal()
    if (legacyStatus) {
      assert.equal(completed.jobs[sourceId].status, legacyStatus === 'running' ? 'interrupted' : 'done')
      assert.equal(completed.jobs[sourceId].prompt, 'original legacy input')
    }
    assert.equal(turns.length, legacyStatus ? 1 : 2, 'a pre-upgrade completed or unknown execution must not run again')
    failAck = false
    fx.connectivityChanged(false)
    fx.connectivityChanged(true)
    await until(() => pending.size === 0, fx.events)
    const retried = await readJournal()
    assert.deepEqual(Object.keys(retried.jobs), Object.keys(completed.jobs), 're-pull retains the same admitted jobs')
    assert.equal(turns.length, legacyStatus ? 1 : 2, 'lost ACK recovery never re-executes a turn')
    assert.ok(receipts.every(receipt => receipt.custody.length === 1))
  } finally { await fx.close() }
})
