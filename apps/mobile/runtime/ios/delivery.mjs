import { buildAgentDeliveryEnvelope, buildAgentMentionContext, formatDeliveryTimestamp, identityShown } from '../../../../packages/core/src/local/agent/deliveryEnvelope.ts'
import { buildThreadBootstrapBody } from '../../../../packages/core/src/local/agent/threadBootstrap.ts'
import { resolveListenModeDefault } from '../../../../packages/core/src/cloud/listenMode.ts'

const fail = (code, message) => Object.assign(new Error(message), { code })
const uuid = (value, label) => {
  if (typeof value !== 'string' || value.length !== 36 || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) throw fail('cloud_protocol_error', `${label} is not a UUID`)
  return value
}
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const optionalUUID = (value, label) => value == null ? null : uuid(value, label)

// Native-only projection of an authoritative pull_agent_inbox_v2 row. This
// calls the shared sole envelope producer, never a second XML implementation.
// Credentials, permission decisions and attachment bytes are not projection input.
export function nativeChatDelivery(input) {
  if (!object(input) || !object(input.row)) throw fail('invalid_args', 'Authoritative inbox row is required')
  const agent = uuid(input.agentUserId, 'Agent'), owner = uuid(input.ownerId, 'Owner'), row = input.row
  const chat = uuid(row.chat_id, 'Chat'), id = uuid(row.id, 'Message')
  if (!Number.isSafeInteger(row.seq) || row.seq < 1 || typeof row.content !== 'string') throw fail('cloud_protocol_error', 'Inbox message content or sequence is invalid')
  if (!['dm', 'ai', 'group', 'topic'].includes(row.chat_kind)) throw fail('unsupported', 'Inbox chat kind is unsupported')
  if (!['file_item_id', 'file_version', 'file_blob_id'].every(key => Object.hasOwn(row, key))) throw fail('cloud_protocol_error', 'Inbox has no authoritative private attachment reference columns')
  if (!['text', 'system'].includes(row.content_type) || row.file_item_id != null || row.file_blob_id != null) throw fail('unsupported', 'Verified private inbox attachment adapter is required')
  if (!Object.hasOwn(row, 'group_rules') || !Object.hasOwn(row, 'named_identities')) throw fail('cloud_protocol_error', 'Inbox has no authoritative rules or named identities')
  if (row.group_rules != null && typeof row.group_rules !== 'string') throw fail('cloud_protocol_error', 'Inbox group rules are invalid')
  if (row.named_identities != null && !object(row.named_identities)) throw fail('cloud_protocol_error', 'Inbox named identities are invalid')
  if (typeof row.created_at !== 'string' || !Number.isFinite(new Date(row.created_at).getTime())) throw fail('cloud_protocol_error', 'Inbox timestamp is invalid')
  const sender = optionalUUID(row.sender_user_id, 'Sender')
  if (!sender && row.content_type !== 'system') throw fail('cloud_protocol_error', 'Only a system message may have no sender')
  const identities = new Map(Object.entries(row.named_identities ?? {}).map(([id, value]) => {
    uuid(id, 'Named identity')
    if (!object(value)) throw fail('cloud_protocol_error', 'Named identity row is invalid')
    return [id, { guguNumber: typeof value.gugu_number === 'number' ? value.gugu_number : null,
      displayName: typeof value.display_name === 'string' && value.display_name.trim() ? value.display_name.trim() : null,
      isAgent: value.type === 'agent' }]
  }))
  if (sender) identities.set(sender, { guguNumber: typeof row.sender_gugu_number === 'number' ? row.sender_gugu_number : null,
    displayName: typeof row.sender_display_name === 'string' && row.sender_display_name.trim() ? row.sender_display_name.trim() : null,
    isAgent: row.sender_type === 'agent' })
  let recipients = null
  if (row.to_user_ids != null) {
    if (!Array.isArray(row.to_user_ids)) throw fail('cloud_protocol_error', 'Inbox recipients are invalid')
    recipients = row.to_user_ids.map(value => value === '*' ? value : uuid(value, 'Recipient'))
  }
  if (row.is_whisper === true && (!sender || recipients?.length !== 1 || recipients[0] === '*')) throw fail('cloud_protocol_error', 'Private inbox message has no exact whisper pair')
  const replyId = optionalUUID(row.reply_to_message_id, 'Reply message'), replySender = optionalUUID(row.reply_to_sender_user_id, 'Reply sender')
  const thread = optionalUUID(row.thread_root_id, 'Thread') ?? (row.is_thread_root === true ? id : null)
  let groupRules = null
  if (row.chat_kind === 'group' || row.chat_kind === 'topic') {
    const decision = input.groupRules, version = decision?.version
    if (!object(decision) || !(version === 'none' || (typeof version === 'string' && version.length === 16 && /^[0-9a-f]{16}$/.test(version))) || !(decision.text === null || typeof decision.text === 'string')) throw fail('invalid_args', 'Native group-rule delivery decision is required')
    const current = typeof row.group_rules === 'string' ? row.group_rules : ''
    if (decision.text !== null && decision.text !== current) throw fail('stale_context', 'Rule delivery text differs from authoritative inbox row')
    groupRules = { version: decision.version, text: decision.text }
  }
  let threadContext = null
  if (input.threadMessages != null) {
    if (!thread || !Array.isArray(input.threadMessages)) throw fail('invalid_args', 'Thread bootstrap requires an authoritative thread')
    const messages = input.threadMessages.map(message => {
      if (!object(message) || typeof message.content !== 'string' || typeof message.created_at !== 'string') throw fail('cloud_protocol_error', 'Thread bootstrap row is invalid')
      return { senderUserId: uuid(message.sender_user_id, 'Thread sender'), content: message.content, createdAt: message.created_at }
    })
    threadContext = buildThreadBootstrapBody(messages, { selfAgentUserId: agent, labelFor: id => identityShown(identities, id) ?? `user:${id}` })
  }
  const messageContext = buildAgentMentionContext(row.content, recipients, identities, agent)
  const envelope = buildAgentDeliveryEnvelope({ guguUserId: agent, chatId: chat, messageId: id, senderUserId: sender,
    contentType: row.content_type, content: row.content,
    replyTo: replyId && replySender ? { messageId: replyId, senderUserId: replySender, content: typeof row.reply_to_content === 'string' ? row.reply_to_content : '' } : null,
    threadRootId: thread, whisperTo: row.is_whisper === true ? recipients : null, viaApp: typeof row.via_app === 'string' ? row.via_app : null }, identities,
  { publicId: typeof row.chat_public_id === 'number' ? row.chat_public_id : null, name: typeof row.chat_name === 'string' ? row.chat_name : null, kind: row.chat_kind,
    ownDm: (row.chat_kind === 'dm' || row.chat_kind === 'ai') && sender === owner }, formatDeliveryTimestamp(row.created_at), null,
  { message: 'message_send' }, { listenMode: resolveListenModeDefault(row.listen_mode), messageContext, threadContext, groupRules })
  return { sourceMessageId: id, seq: row.seq, chatId: chat, envelope,
    route: { kind: 'chat', chatId: chat, sourceMessageId: id, senderUserId: sender, threadRootId: thread, whisper: row.is_whisper === true },
    groupRulesDelivered: groupRules && groupRules.text !== null ? { chatId: chat, version: groupRules.version } : null }
}
