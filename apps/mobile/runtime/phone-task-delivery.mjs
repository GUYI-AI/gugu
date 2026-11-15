import { buildAgentDeliveryEnvelope, formatDeliveryTimestamp } from '../../../packages/core/src/local/agent/deliveryEnvelope.ts'
import { serializeComposerCard } from '../../../packages/core/src/shared/ui/taskCardModels.ts'
import { uuid } from './phone-agent-store.mjs'

const first = value => Array.isArray(value) ? value[0] : value

async function readChat(cloud, address) {
  const query = cloud.chat.from('chats').select('id,kind,status,public_id,name,source_chat_id')
  const { data, error } = /^\d+$/.test(address)
    ? await query.eq('public_id', Number(address)).single()
    : await query.eq('id', uuid(address, 'task chat')).single()
  if (error) throw new Error(error.message)
  if (!data || data.status === 'archived' || !['group', 'topic', 'dm', 'ai'].includes(data.kind)) throw new Error('任务目的地不是有效对话或话题')
  return data
}

/** The birth group controls joining; the task chat controls where the card and reply land. */
export async function resolvePhoneTaskDestination(cloud, address, birthGroupChatId, actorId) {
  const room = await readChat(cloud, address)
  if (room.kind === 'topic' && !room.source_chat_id) throw new Error('任务话题没有来源对话')
  const source = room.kind === 'topic' ? await readChat(cloud, room.source_chat_id) : room
  if (source.kind === 'topic') throw new Error('任务话题的来源不能是另一条话题')
  const groupId = source.kind === 'group' ? source.id : null
  if (birthGroupChatId && groupId !== birthGroupChatId) throw new Error('任务话题不属于本次新建任务的来源群')
  // An Agent caller does not acquire its owner's visibility by supplying a destination.
  const facts = first(await cloud.rpc('chat', 'chat_facts', { p_chat_id: room.id, p_as_user_id: actorId }))
  if (!facts || facts.kind !== room.kind) throw new Error('任务目的地对发起人不可见')
  return { chatId: room.id, kind: room.kind, publicId: room.public_id ?? null, name: room.name ?? null,
    membershipChatId: room.kind === 'topic' ? source.id : room.id, birthGroupChatId: groupId }
}

/** Called before admission. Its stable message id makes a crash after the card write safe to retry. */
export async function landPhoneTaskFirstTurn({ request, agent, ownerId, cloud, deviceId, projectId, machineLabel, resolveIdentities }) {
  const destination = await resolvePhoneTaskDestination(cloud, request.taskChatId, request.birthGroupChatId, request.caller?.agentUserId ?? ownerId)
  const social = destination.kind === 'group' || destination.kind === 'topic'
  let seat = null
  if (social) {
    const result = await cloud.chat.from('active_members').select('user_id')
      .eq('chat_id', destination.membershipChatId).eq('user_id', agent.agentUserId).maybeSingle()
    if (result.error) throw new Error(result.error.message)
    seat = result.data
  }
  const { data: face, error: faceError } = await cloud.identity.from('users').select('avatar').eq('id', agent.agentUserId).maybeSingle()
  if (faceError) throw new Error(faceError.message)
  const written = first(await cloud.rpc('chat', 'send_message_idempotent', {
    p_message_id: request.taskMessageId, p_chat_id: destination.chatId, p_sender_user_id: ownerId, p_to_user_ids: [],
    p_content: serializeComposerCard({ v: 1, type: 'task', text: request.prompt, agentUserId: agent.agentUserId,
      agentName: agent.displayName, agentType: 'pi', agentAvatar: face?.avatar ?? null,
      sessionId: agent.sessionId, projectId, deviceId, machineLabel }),
    p_content_type: 'card', p_reply_to_message_id: null, p_thread_root_id: null, p_is_thread_root: false, p_is_whisper: false,
  }))
  if (written?.id !== request.taskMessageId || written?.chat_id !== destination.chatId) throw new Error('任务卡写入没有返回对应消息')

  if (!social || !seat) {
    const hint = !social ? '' : agent.birthGroup?.status === 'pending_approval'
      ? '\n\n任务卡已留在所选对话，来源群入群申请正在等待管理员审批。你现在没有在该话题或群发言的权限，请先在自己的任务时间线回答。'
      : '\n\n任务卡已留在所选对话，但你现在还不是来源群的成员，请先在自己的任务时间线回答，不要往群或话题发消息。'
    return { id: request.taskMessageId, agentUserId: agent.agentUserId, prompt: request.prompt + hint, route: { kind: 'task', senderUserId: ownerId } }
  }
  const identities = await resolveIdentities([ownerId, agent.agentUserId])
  if (!identities.has(ownerId)) throw new Error('任务首句的发起人身份不可见')
  const prompt = buildAgentDeliveryEnvelope({ guguUserId: agent.agentUserId, chatId: destination.chatId,
    messageId: request.taskMessageId, senderUserId: ownerId, replyTo: null, threadRootId: null, content: request.prompt },
  identities, { publicId: destination.publicId, name: destination.name, kind: destination.kind }, formatDeliveryTimestamp(new Date().toISOString()))
  return { id: request.taskMessageId, agentUserId: agent.agentUserId, prompt,
    route: { kind: 'chat', chatId: destination.chatId, sourceMessageId: request.taskMessageId, senderUserId: ownerId } }
}
