import { recordPhoneOwnerNotice } from './phone-conversation-publications.mjs'
import { effectiveGroupRules, groupRulesVersion, groupRulesLedgerFor } from '../../../packages/core/src/local/agent/groupRulesDelivery.ts'
import { stableId, uuid } from './phone-agent-store.mjs'
import { createPhoneChatAccess } from './phone-agent-chat.mjs'

const toolResult = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data) }], details: data })
const text = (value, name) => { if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} is required`); return value.trim() }
const bare = (value, prefix) => value.startsWith(`${prefix}:`) ? value.slice(prefix.length + 1) : value
const rowOf = (data) => Array.isArray(data) ? data[0] : data

/** The Pi tools are real Gugu writes with the agent's own sender identity. */
export function phoneCommunicationTools({ agent, job, cloud, store, env, deviceId, sendSession, emit, publicationQueued = () => {}, authorize }) {
  const chatAccess = createPhoneChatAccess({ agent, cloud, store, env })
  const chatId = async (value) => {
    const target = text(value, 'chat_id')
    if (/^\d+$/.test(target)) {
      const { data, error } = await cloud.chat.from('chats').select('id').eq('public_id', Number(target)).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'chat_id')
    }
    return uuid(target, 'chat_id')
  }
  const userId = async (value) => {
    if (value.startsWith('user:')) return uuid(bare(value, 'user'), 'recipient')
    if (value.startsWith('session:')) {
      const target = Object.values(store.state.agents).find((item) => item.sessionId === bare(value, 'session'))
      if (!target) throw new Error('That session is not on this phone; contact it with session_message')
      return target.agentUserId
    }
    if (/^gugu:\d+$/.test(value)) {
      const { data, error } = await cloud.identity.from('active_users').select('id').eq('gugu_number', Number(bare(value, 'gugu'))).single()
      if (error) throw new Error(error.message)
      return uuid(data.id, 'recipient')
    }
    throw new Error('Recipients must use a user:, gugu: or session: address')
  }
  const facts = async (id) => rowOf(await cloud.rpc('chat', 'chat_facts', { p_chat_id: id, p_as_user_id: agent.agentUserId }))
  const ledger = groupRulesLedgerFor(env)
  const rules = async (id) => effectiveGroupRules(id, facts)
  const messageSend = async (callId, args) => {
    await authorize(job.usedGroups ?? [])
    const id = await chatId(args.chat_id)
    const body = text(args.text, 'text')
    const currentRules = await rules(id)
    if (currentRules.trim()) {
      const seen = await ledger.read(agent.agentUserId, id)
      if (seen?.version !== groupRulesVersion(currentRules)) throw new Error("Call message_rules to read this chat's current group rules before sending")
    }
    const recipients = Array.isArray(args.to_user_ids) ? await Promise.all(args.to_user_ids.map(userId)) : null
    await chatAccess.beforeWrite(id, recipients)
    if (args.whisper && recipients?.length !== 1) throw new Error('A whisper must name exactly one recipient')
    const replyToMessageId = args.reply_to_message_id ? await chatAccess.messageId(args.reply_to_message_id, id, 'reply source') : null
    const notice = id === agent.chatId && (!recipients?.length || recipients.includes(store.state.ownerId)) && deviceId
      ? recordPhoneOwnerNotice(store, job, agent, deviceId, callId, body) : null
    const messageId = notice?.publicationId ?? stableId('phone-message', agent.agentUserId, job.id, callId)
    const message = { id: messageId, chatId: id, agentUserId: agent.agentUserId, sessionId: agent.sessionId, usedGroups: [...(job.usedGroups ?? [])], permissionRequirements: structuredClone(job.permissionRequirements ?? []), toUserIds: recipients, content: body, replyToMessageId, threadRootId: job.route?.chatId === id ? job.route.threadRootId ?? null : null, isWhisper: args.whisper === true }
    const previous = store.state.outbox[messageId]
    if (previous && ['chatId', 'content', 'toUserIds', 'replyToMessageId', 'threadRootId', 'isWhisper'].some(key => JSON.stringify(previous[key]) !== JSON.stringify(message[key]))) throw new Error('phone message admission payload changed')
    store.state.outbox[messageId] ??= { ...message, status: 'pending', createdAt: new Date().toISOString() }
    await store.save()
    if (notice) publicationQueued()
    const data = await deliverPhoneOutbox(cloud, store, messageId, authorize)
    job.sent = [...new Set([...(job.sent ?? []), messageId])]
    await store.save()
    emit({ type: 'message_sent', sessionId: agent.sessionId, agentUserId: agent.agentUserId, chatId: id, messageId })
    return toolResult({ ok: true, message_id: `msg:${messageId}`, chat_id: id, message: data })
  }
  return [
    {
      name: 'message_send', label: 'Send a Gugu message', description: 'Sends a message as your own Gugu Agent identity. Take chat_id from this turn\'s delivery or message_conversations, and recipient addresses from message_members. Replying to a chat delivery requires this tool; printing a final answer sends nothing. In a group, name recipients explicitly by typed address; when replying, pass reply_to_message_id.',
      parameters: { type: 'object', required: ['chat_id', 'text'], properties: { chat_id: { type: 'string' }, text: { type: 'string' }, to_user_ids: { type: 'array', items: { type: 'string' } }, reply_to_message_id: { type: 'string' }, whisper: { type: 'boolean' } } },
      execute: messageSend,
    },
    {
      name: 'message_rules', label: 'Read current group rules', description: 'Reads the current group rules of this chat and its source group as your Agent identity; do this group-rules check before sending.',
      parameters: { type: 'object', required: ['chat_id'], properties: { chat_id: { type: 'string' } } },
      execute: async (_callId, args) => {
        const id = await chatId(args.chat_id)
        const current = await rules(id)
        await ledger.write(agent.agentUserId, id, { version: groupRulesVersion(current), contextKey: agent.sessionId })
        return toolResult({ chat_id: id, rules: current })
      },
    },
    {
      name: 'session_message', label: 'Message another task Agent', description: 'Sends a message to a task session. Address recipients as session:<id>. When this turn came from session-direct, you must reply to the source session with this tool. The message travels over Gugu device RPC to the recipient\'s host.',
      parameters: { type: 'object', required: ['to', 'text'], properties: { to: { type: 'array', minItems: 1, items: { type: 'string' } }, text: { type: 'string' }, reply_to_message_id: { type: 'string' }, then: { type: 'string', enum: ['continue', 'wait', 'stop'] }, work_result: { type: 'object', required: ['work_id', 'status'], additionalProperties: false, properties: { work_id: { type: 'string', format: 'uuid' }, status: { type: 'string', enum: ['progress', 'question', 'completed', 'cancelled'] } } } } },
      execute: async (callId, args) => {
        await authorize(job.usedGroups ?? [])
        if (!Array.isArray(args.to) || !args.to.length) throw new Error('to is required')
        const ids = [...new Set(args.to.map((id) => uuid(bare(id, 'session'), 'session recipient')))]
        const work = args.work_result
        if (work && (Object.keys(work).some(key => !['work_id', 'status'].includes(key)) || !['progress', 'question', 'completed', 'cancelled'].includes(work.status))) throw new Error('Invalid work_result')
        if (work) uuid(work.work_id, 'work_id')
        const result = await sendSession(agent, ids, text(args.text, 'text'), { reply_to_message_id: args.reply_to_message_id, then: args.then, ...(work ? { work_result: work } : {}) }, stableId(job.id, callId))
        job.sent = [...new Set([...(job.sent ?? []), callId])]
        await store.save()
        return toolResult(result)
      },
    },
    {
      name: 'profile_whoami', label: 'View your own identity', description: 'Returns your own real Gugu Agent identity and where you run on the phone.',
      parameters: { type: 'object', properties: {} },
      execute: async () => {
        const { data, error } = await cloud.identity.from('active_users').select('id,display_name,gugu_number,owner_user_id,device_id').eq('id', agent.agentUserId).single()
        if (error) throw new Error(error.message)
        return toolResult({ user_id: `user:${agent.agentUserId}`, session_id: `session:${agent.sessionId}`, display_name: data.display_name, gugu_number: data.gugu_number, device_id: `device:${agent.deviceId}`, owner_user_id: `user:${store.state.ownerId}` })
      },
    },
  ]
}

export async function deliverPhoneOutbox(cloud, store, id, authorize = async () => undefined) {
  const message = store.state.outbox[id]
  if (!message) throw new Error('phone reply journal entry is missing')
  if (message.status === 'sent') return message.receipt
  if (message.status === 'revoked') throw new Error('Permission for this phone result was revoked; it cannot be delivered again')
  try { await authorize(message.usedGroups ?? [], message) } catch (error) {
    if (['revoked', 'not_granted', 'os_permission'].includes(error.code)) {
      message.status = 'revoked'; message.error = error.message
      await store.save()
    }
    throw error
  }
  const data = await cloud.rpc('chat', 'send_message_idempotent', {
    p_message_id: message.id, p_chat_id: message.chatId, p_sender_user_id: message.agentUserId,
    p_to_user_ids: message.toUserIds, p_content: message.content, p_content_type: 'text',
    p_reply_to_message_id: message.replyToMessageId, p_thread_root_id: message.threadRootId,
    p_is_thread_root: false, p_is_whisper: message.isWhisper,
  })
  const row = rowOf(data)
  if (!row || typeof row.id !== 'string') throw new Error('send_message_idempotent returned no message receipt')
  message.status = 'sent'; message.receipt = { id: row.id }; message.sentAt = new Date().toISOString()
  await store.save()
  return message.receipt
}
