// gugu-dev#181「派任务」: a task dispatched from a chat's composer lands its first turn as a task card in that chat.
//
// It is the chat-page first turn (main.ts `landChatPageFirstTurn`) with another landing: the same idempotent owner
// write keyed by the session's stable `initialMessageId`, after the agent's cloud identity has settled — by then a
// group it was born in has answered its join (joined, or queued for the owner's approval) and its name is final.
//   · The card is the owner's own message and names nobody: the cloud delivery trigger skips cards, so it wakes no
//     one; the words reach the new agent only as this first turn.
//   · In a group the first turn is that group's delivery envelope for the card, so the agent answers in the group,
//     quoting the card. Its message_context always says the card is the agent's first task, owed an answer as an
//     @ would be; a seated agent also gets the group's rules, recorded as delivered so its first send is not
//     refused. Until the group has let it in (approval pending, or refused) it cannot post there: the context says
//     to answer in its own session instead.
//   · In a direct chat with a person the agent can never join: the card stays there and the agent gets the plain
//     words — its answer is its own session.
import { listAgents } from '@gugu/core'
import type { GuguIdentity } from '@gugu/core/local/agent/deliveryEnvelope'
import type { FirstTurnRender } from '@gugu/core/local/agent/firstTurnRender'
import {
  decideGroupRulesDelivery,
  effectiveGroupRules,
  groupRulesLedgerFor,
  type ChatFactsRow,
  type GroupRulesLedger,
} from '@gugu/core/local/agent/groupRulesDelivery'
import { encodeTypedId } from '@gugu/core/shared/typedId.mjs'
import { serializeComposerCard } from '@gugu/core/shared/ui/taskCardModels'
import { makeChatClient, makeIdentityClient } from '../supabase'
import { awaitSessionpageCloudIdentity } from './emdash-agent-provisioning'

export interface TaskCardFirstTurnInput {
  auth: { accessToken: string; userId: string }
  sessionId: string
  projectId: string
  agentUserId: string
  chatId: string
  messageId: string
  text: string
  files?: import('@gugu/session-core/session-record/contract').TurnFileRef[]
  deviceId: string
  machineLabel: string
  senderIdentities: Map<string, GuguIdentity>
  timestamp: string
  env: NodeJS.ProcessEnv
  /** Where delivered rules are recorded; defaults to this machine's (`groupRulesLedgerFor(env)`). */
  groupRulesLedger?: GroupRulesLedger
}

/** `envelope` = the first turn is a chat delivery the agent answers in that chat; otherwise plain words. */
export interface TaskCardFirstTurn {
  /** Where the agent answers: the chat the card is in. */
  chatId: string
  /** How the session's first-turn row is written for the agent (the row keeps its own text). */
  render: FirstTurnRender
}

// The card names nobody (to_user_ids stays []), so the envelope alone reads as an unaddressed group message, and the
// platform's silence rule lets an agent stay quiet on one (hello 8, 11-26: a new agent sat silent on its own card).
export const TASK_CARD_DISPATCH =
  '这是一张任务卡：发卡的人在这个群里新建了你，卡上的话就是交给你的第一件活。它等同于 @ 你，必须回应；做不了也要回一句说明。'

// 先看再发:没进群时 message_send 必然被拒,而有的 harness 把一次失败的咕咕工具调用记成整轮失败(Codex 实测)。
export const TASK_CARD_NOT_MEMBER_HINT =
  '你现在还不是这个群的成员：交结果之前先用 message_members 看你是不是这个群的成员 —— 是，就照常在群里回、引用这张卡；还不是，就把结果直接回在你自己的会话里，不往群里发。'

export async function landTaskCardFirstTurn(input: TaskCardFirstTurnInput): Promise<TaskCardFirstTurn> {
  const text = input.text.trim()
  if (!text) throw new Error(`task card for ${input.sessionId} has no text`)
  await awaitSessionpageCloudIdentity(input.agentUserId)
  const agent = (await listAgents(input.env, { includeGuests: true })).find((row) => row.gugu_user_id === input.agentUserId)
  if (!agent) throw new Error(`task card for ${input.sessionId}: no roster row for agent ${input.agentUserId}`)

  const chat = makeChatClient(input.auth.accessToken)
  const { data: room, error: roomError } = await chat.from('chats')
    .select('id, kind, public_id, name').eq('id', input.chatId).maybeSingle()
  if (roomError) throw new Error(`task card for ${input.sessionId}: read chat ${input.chatId}: ${roomError.message}`)
  if (!room) throw new Error(`task card for ${input.sessionId}: chat ${input.chatId} is not visible to its owner`)
  const kind = (room as { kind?: string | null }).kind ?? null
  const { data: face, error: faceError } = await makeIdentityClient(input.auth.accessToken).from('users')
    .select('avatar').eq('id', input.agentUserId).maybeSingle()
  if (faceError) throw new Error(`task card for ${input.sessionId}: read the agent's avatar: ${faceError.message}`)

  const { error: writeError } = await chat.rpc('send_message_idempotent', {
    p_message_id: input.messageId,
    p_chat_id: input.chatId,
    p_sender_user_id: input.auth.userId,
    p_to_user_ids: [],
    p_content: serializeComposerCard({
      v: 1,
      type: 'task',
      text,
      ...(input.files?.length ? { files: input.files } : {}),
      agentUserId: input.agentUserId,
      agentName: agent.name,
      agentType: agent.agent_type,
      agentAvatar: (face as { avatar?: string | null } | null)?.avatar ?? null,
      sessionId: input.sessionId,
      projectId: input.projectId,
      deviceId: input.deviceId,
      machineLabel: input.machineLabel,
    }),
    p_content_type: 'card',
    p_reply_to_message_id: null,
    p_thread_root_id: null,
    p_is_thread_root: false,
    p_is_whisper: false,
  })
  if (writeError) throw new Error(`task card for ${input.sessionId}: write failed: ${writeError.message}`)

  if (kind !== 'group') return { chatId: input.chatId, render: { kind: 'plain' } }

  const { data: seat, error: seatError } = await chat.from('active_members')
    .select('user_id').eq('chat_id', input.chatId).eq('user_id', input.agentUserId).maybeSingle()
  if (seatError) throw new Error(`task card for ${input.sessionId}: read the agent's seat: ${seatError.message}`)
  const cardId = encodeTypedId('msg', input.messageId)
  let messageContext = `${TASK_CARD_DISPATCH}\n`
  let groupRules: { version: string; text: string | null } | undefined
  if (seat) {
    messageContext += `在本群回复并引用这张卡（reply_to_message_id = ${cardId}）。`
    // #3641 as the inbox reader does it: the agent's own view of the room (chat_facts), read now, never cached.
    const rules = await effectiveGroupRules(input.chatId, async (id) => {
      const { data, error } = await chat.rpc('chat_facts', { p_chat_id: id, p_as_user_id: input.agentUserId })
      if (error) throw new Error(`task card for ${input.sessionId}: read the rules of ${id}: ${error.message}`)
      const row = (Array.isArray(data) ? data[0] : data) as ChatFactsRow | undefined
      // A seated agent that cannot see its room would be told "no rules" — not knowing is not "none".
      if (!row && id === input.chatId) throw new Error(`task card for ${input.sessionId}: chat_facts has no row of ${id} for its agent`)
      return row ?? null
    })
    // A first turn opens the agent's context: whatever the ledger says, this context has not seen the rules yet.
    groupRules = decideGroupRulesDelivery({ rules, delivered: null, contextKey: null })
  } else {
    messageContext += TASK_CARD_NOT_MEMBER_HINT
    const { data: request, error: requestError } = await chat.from('group_join_requests')
      .select('status').eq('chat_id', input.chatId).eq('requester_user_id', input.agentUserId)
      .eq('status', 'pending').maybeSingle()
    if (requestError) throw new Error(`task card for ${input.sessionId}: read the agent's join request: ${requestError.message}`)
    if (request) messageContext += '你的入群申请正在等待群管理员同意。'
  }
  if (groupRules && groupRules.text !== null) {
    // The record message_send's rules gate reads (gugu-im-server `assertGroupRulesSeen`, version only): without it the
    // agent's first answer here is refused once although its turn carried the rules. The provider context has no id yet,
    // so the entry names none — it never matches a live reader's `<session>:<provider>` key, and the next delivery from
    // this room carries the rules once more rather than once fewer.
    await (input.groupRulesLedger ?? groupRulesLedgerFor(input.env))
      .write(input.agentUserId, input.chatId, { version: groupRules.version, contextKey: null })
  }
  return {
    chatId: input.chatId,
    render: {
      kind: 'envelope',
      envelope: { guguUserId: input.agentUserId, chatId: input.chatId, messageId: input.messageId, senderUserId: input.auth.userId, replyTo: null, threadRootId: null },
      identities: input.senderIdentities,
      chat: {
        publicId: (room as { public_id?: number | null }).public_id ?? null,
        name: (room as { name?: string | null }).name ?? null,
        kind: 'group',
      },
      timestamp: input.timestamp,
      messageContext,
      ...(groupRules ? { groupRules } : {}),
    },
  }
}
