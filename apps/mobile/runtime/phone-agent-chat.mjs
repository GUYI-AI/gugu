import { windowResult, matchesAgentStatus } from '../../desktop/electron/mcp/list-window.mjs'
import { effectiveGroupRules, groupRulesLedgerFor, groupRulesVersion } from '../../../packages/core/src/local/agent/groupRulesDelivery.ts'
import { uuid } from './phone-agent-store.mjs'
import { matchIdPrefix, uuidPrefixRange } from '../../../packages/core/src/shared/idPrefix.ts'

const row = (value) => Array.isArray(value) ? value[0] : value
const result = (value) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], details: value })
const bare = (value, kind) => typeof value === 'string' ? value.replace(new RegExp(`^${kind}:`), '') : value
const limited = (value, fallback = 20) => { if (value === undefined) return fallback; if (!Number.isInteger(value) || value < 1 || value > 100) throw new Error('limit must be between 1 and 100'); return value }
const listProperties = { name: { type: 'string' }, rows: { type: 'string' } }

export function encodePhoneChatRows(value, messageRows = false) {
  if (Array.isArray(value)) return value.map((item) => encodePhoneChatRows(item, messageRows))
  if (!value || typeof value !== 'object') return value
  const out = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === 'string' && !entry.includes(':') && ['user_id', 'sender_user_id', 'owner_user_id', 'creator_user_id', 'agent_user_id', 'peer_user_id', 'reply_to_sender_user_id'].includes(key)) out[key] = `user:${entry}`
    else if (typeof entry === 'string' && !entry.includes(':') && (['message_id', 'reply_to_message_id', 'thread_root_id', 'source_message_id'].includes(key) || (messageRows && key === 'id'))) out[key] = `msg:${entry}`
    else if (key === 'to_user_ids' && Array.isArray(entry)) out[key] = entry.map((id) => id.includes(':') ? id : `user:${id}`)
    else out[key] = encodePhoneChatRows(entry, false)
  }
  return out
}

export function createPhoneChatAccess({ agent, cloud, store, env }) {
  const chats = async () => {
    const data = await cloud.rpc('chat', 'list_my_chats_as', { p_as_user_id: agent.agentUserId })
    if (!Array.isArray(data)) throw new Error('The Agent chat list did not return a list')
    return data
  }
  const chatId = async (address) => {
    if (typeof address !== 'string' || !address.trim()) throw new Error("chat_id is required; take it from message_conversations or this turn's envelope")
    if (/^\d+$/.test(address)) {
      const { data, error } = await cloud.chat.from('chats').select('id').eq('public_id', Number(address)).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'chat_id')
    }
    return uuid(address, 'chat_id')
  }
  const userId = async (address) => {
    if (typeof address !== 'string') throw new Error('Recipients must use a typed address')
    if (address.startsWith('user:') || address.startsWith('aid:')) return uuid(address.slice(address.indexOf(':') + 1), 'recipient')
    if (address.startsWith('session:')) {
      const target = Object.values(store.state.agents).find((item) => item.sessionId === bare(address, 'session'))
      if (!target) throw new Error('That session is not on this phone; contact it with session_message')
      return target.agentUserId
    }
    if (/^gugu:\d+$/.test(address)) {
      const { data, error } = await cloud.identity.from('active_users').select('id').eq('gugu_number', Number(bare(address, 'gugu'))).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'recipient')
    }
    throw new Error('Recipients must use a user:, aid:, gugu: or session: address')
  }
  const members = async (id) => {
    const data = await cloud.rpc('chat', 'list_member_ids', { p_chat_id: id, p_as_user_id: agent.agentUserId })
    if (!Array.isArray(data)) throw new Error('The chat member list did not return a list')
    return data
  }
  // A msg id written as its first 8+ characters (idPrefix.ts, the desktop's matcher): matched in this chat, among what this
  // agent may read; only the full id goes on.
  const messageId = async (value, id, label) => {
    const written = bare(value, 'msg')
    if (typeof written !== 'string' || !uuidPrefixRange(written)) return uuid(written, label)
    const rows = await cloud.rpc('chat', 'messages_by_id_as', { p_as: agent.agentUserId, p_id: written, p_chat_id: id }) ?? []
    return matchIdPrefix({
      kind: 'msg', id: written, rows, keyOf: (message) => message.id, noun: 'messages',
      describe: (message) => `${JSON.stringify(String(message.content ?? '').slice(0, 40))}, ${message.created_at}`,
      notFound: (address) => `No message matches ${address} in this chat; message_history lists message ids`,
    })
  }
  const facts = async (id) => row(await cloud.rpc('chat', 'chat_facts', { p_chat_id: id, p_as_user_id: agent.agentUserId }))
  const rules = (id) => effectiveGroupRules(id, facts)
  const ledger = groupRulesLedgerFor(env)
  const beforeWrite = async (id, recipients = null) => {
    const membersHere = await members(id)
    if (!membersHere.some((member) => member.user_id === agent.agentUserId)) throw new Error('You are not a member of this chat; check available chats with message_conversations')
    const missing = (recipients ?? []).filter((uid) => !membersHere.some((member) => member.user_id === uid))
    if (missing.length) throw new Error(`Recipients not in this chat: ${missing.map((uid) => `user:${uid}`).join(', ')}. Call message_members for valid members.`)
    const current = await rules(id)
    if (current.trim() && (await ledger.read(agent.agentUserId, id))?.version !== groupRulesVersion(current)) throw new Error('Call message_rules to read the current group rules before sending')
  }
  return { chats, chatId, userId, messageId, members, facts, rules, ledger, beforeWrite }
}

/** Reads always use the agent-as RPCs; the owner JWT never broadens the agent's history. */
export function phoneChatReadTools({ agent, cloud, store, env }) {
  const access = createPhoneChatAccess({ agent, cloud, store, env })
  const identityRows = async (ids) => {
    const all = []
    for (let offset = 0; offset < ids.length; offset += 50) {
      const { data, error } = await cloud.identity.from('users').select('id,display_name,type,gugu_number').in('id', ids.slice(offset, offset + 50))
      if (error) throw new Error(error.message)
      all.push(...(data ?? []))
    }
    return new Map(all.map((user) => [user.id, user]))
  }
  const history = async (args, search = false) => {
    const id = await access.chatId(args.chat_id)
    const query = { p_chat_id: id, p_as_user_id: agent.agentUserId, p_before_seq: args.before_seq ?? null, p_limit: limited(args.limit) }
    if (args.before_seq !== undefined && !Number.isSafeInteger(args.before_seq)) throw new Error('before_seq must be an integer seq returned with messages')
    const data = search
      ? await cloud.rpc('chat', 'message_search_as', { ...query, p_query: String(args.query ?? '') })
      : await cloud.rpc('chat', 'message_history_as', { ...query, p_thread_root_id: args.thread_root_id ? await access.messageId(args.thread_root_id, id, 'thread_root_id') : null })
    if (!Array.isArray(data)) throw new Error('Message history did not return a list')
    return result(encodePhoneChatRows(data, true))
  }
  return [
    { name: 'message_conversations', label: 'View your chats', description: 'Lists the DMs, groups and topics you have actually joined as this Agent, most recent message first. Returns chat_id/public_id; use them for history or sending, never guess numbers.', parameters: { type: 'object', properties: { ...listProperties, kind: { type: 'string', enum: ['dm', 'group', 'topic', 'ai'] }, pinned: { type: 'boolean' } } }, execute: async (_callId, args) => {
      const [rows, pins] = await Promise.all([access.chats(), cloud.chat.from('active_members').select('chat_id').eq('user_id', store.state.ownerId).eq('is_pinned', true)])
      if (pins.error) throw new Error(pins.error.message)
      const pinned = new Set((pins.data ?? []).map((item) => item.chat_id))
      const shown = rows.map((item) => ({ id: item.chat_id, chat_id: item.chat_id, public_id: item.public_id, kind: item.kind, status: item.status, name: item.name, pinned: pinned.has(item.chat_id), last_message_at: item.last_message_at, last_message_preview: item.last_message_preview }))
      return result(windowResult({ namesOf: (item) => [item.name], keep: (item, filter) => (!filter.kind || item.kind === filter.kind) && (filter.pinned === undefined || item.pinned === filter.pinned) }, shown, args))
    } },
    { name: 'message_members', label: 'View chat members', description: 'Lists chat members within your visibility as this Agent, returning reusable user: addresses, names and gugu numbers; find people by name, then send.', parameters: { type: 'object', required: ['chat_id'], properties: { chat_id: { type: 'string' }, ...listProperties, type: { type: 'string', enum: ['human', 'agent'] }, status: { type: 'string' } } }, execute: async (_callId, args) => {
      const members = await access.members(await access.chatId(args.chat_id))
      const identities = await identityRows(members.map((item) => item.user_id))
      const agentIds = members.filter((item) => identities.get(item.user_id)?.type === 'agent' && !store.state.agents[item.user_id]).map((item) => item.user_id)
      const presence = new Map()
      const unavailable = []
      for (let offset = 0; offset < agentIds.length; offset += 200) {
        try {
          const data = await cloud.rpc('identity', 'get_agent_presence_batch', { p_agent_user_ids: agentIds.slice(offset, offset + 200) })
          for (const id of agentIds.slice(offset, offset + 200)) if (data?.results?.[id]?.status === 'presence') presence.set(id, data.results[id].presence)
        } catch (error) { unavailable.push(`cloud presence: ${error.message}`) }
      }
      const rows = members.map((member) => {
        const user = identities.get(member.user_id)
        const local = store.state.agents[member.user_id]
        const published = presence.get(member.user_id)
        return { ...member, display_name: user?.display_name ?? null, type: user?.type ?? null, gugu_number: user?.gugu_number ?? null, is_self: member.user_id === agent.agentUserId,
          ...(local ? { status: local.status, detail: local.status === 'working' ? 'running' : null, status_from: 'this_machine' } : published ? { status: published.agent_status, detail: published.agent_status_detail, status_from: 'cloud', status_at: published.updated_at, host_online: published.device_status === 'online' ? true : published.device_status === 'offline' ? false : null } : {}) }
      }).sort((a, b) => String(a.display_name ?? '').localeCompare(String(b.display_name ?? '')) || a.user_id.localeCompare(b.user_id))
      const directory = windowResult({ namesOf: (item) => [item.display_name], statusFilter: true, keep: (item, filter) => (!filter.type || item.type === filter.type) && matchesAgentStatus(item, filter.status) }, rows, args)
      if (unavailable.length) directory.status_unavailable = unavailable.join('; ')
      return result(encodePhoneChatRows(directory))
    } },
    { name: 'message_history', label: 'Read message history', description: "Reads a chat's main timeline or a given thread as your own Agent identity. Page with the returned seq and before_seq; hidden history and whispers are checked by the server against your identity.", parameters: { type: 'object', required: ['chat_id'], properties: { chat_id: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, before_seq: { type: 'integer' }, thread_root_id: { type: 'string' } } }, execute: (_callId, args) => history(args) },
    { name: 'message_search', label: 'Search messages', description: 'Searches the messages in this chat you can actually read, returning their sources and seq; page with before_seq.', parameters: { type: 'object', required: ['chat_id', 'query'], properties: { chat_id: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 100 }, before_seq: { type: 'integer' } } }, execute: (_callId, args) => history(args, true) },
  ]
}
