// gugu-dev#181「派任务」:派出去的任务首句落成那个对话里的一张任务卡(宿主以主人身份写、不叫醒人),
// agent 拿到的第一轮按落点不同:群 = 这个群的投递信封(回群、引用卡);还没进群 = 信封里多一句「回在你自己的会话里」;
// 和人的私聊 = 原话(agent 进不去私聊)。项目群与普通群同一套:卡在群里、agent 的座位不动、不开话题。
// 群里的首轮总带派活说明(卡不点名,不说就是一条没 @ 它的群消息);在群里的再带群规并记为已送达(hello 8,11-26)。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseComposerCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import { renderFirstTurn } from '../../../../packages/core/src/local/agent/firstTurnRender'
import { groupRulesVersion, memoryGroupRulesLedger, type GroupRulesLedger } from '../../../../packages/core/src/local/agent/groupRulesDelivery'

const roster = [{ name: 'Claude 7', gugu_user_id: 'agent-7', agent_type: 'claude-code', path: '', prompt: '', created_at: 0 }]
const LOOK = 'https://storage.test/avatars/agent-look/v1/agent-7.json'
const chats = new Map<string, { kind: string; public_id: number | null; name: string | null; members: string[]; rules?: string }>()
const writes: Array<Record<string, unknown>> = []
const awaited: string[] = []
const rpcs: Array<{ name: string; args: Record<string, unknown> }> = []
const factReads: Array<Record<string, unknown>> = []
const pendingRequests = new Set<string>()
const factsHidden = new Set<string>()
let ledger: GroupRulesLedger = memoryGroupRulesLedger()

vi.mock('@gugu/core', () => ({ listAgents: vi.fn(async () => roster) }))
vi.mock('../../../../apps/desktop/electron/sessionpage/emdash-agent-provisioning', () => ({
  awaitSessionpageCloudIdentity: vi.fn(async (agentUserId: string) => { awaited.push(agentUserId) }),
}))
vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeIdentityClient: () => ({
    from: (table: string) => {
      const filters: Record<string, string> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { filters[column] = value; return query },
        maybeSingle: async () => ({ data: table === 'users' && filters.id === 'agent-7' ? { avatar: LOOK } : null, error: null }),
      }
      return query
    },
  }),
  makeChatClient: () => ({
    from(table: string) {
      const filters: Record<string, string> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { filters[column] = value; return query },
        maybeSingle: async () => {
          if (table === 'chats') {
            const chat = chats.get(filters.id ?? '')
            return { data: chat ? { id: filters.id, kind: chat.kind, public_id: chat.public_id, name: chat.name } : null, error: null }
          }
          if (table === 'group_join_requests') {
            return { data: pendingRequests.has(filters.chat_id ?? '') ? { status: 'pending' } : null, error: null }
          }
          const chat = chats.get(filters.chat_id ?? '')
          return { data: chat?.members.includes(filters.user_id ?? '') ? { user_id: filters.user_id } : null, error: null }
        },
      }
      return query
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name === 'send_message_idempotent') {
        writes.push(args)
        return { error: null }
      }
      if (name === 'chat_facts') {
        // As the RPC does: the room as its agent sees it, no row for a room the agent cannot see.
        factReads.push(args)
        const chat = chats.get(args.p_chat_id as string)
        const visible = chat?.members.includes(args.p_as_user_id as string) && !factsHidden.has(args.p_chat_id as string)
        return { data: visible ? [{ kind: chat!.kind, source_chat_id: null, group_prompt: chat!.rules ?? null }] : [], error: null }
      }
      rpcs.push({ name, args })
      throw new Error(`unexpected rpc ${name}`)
    },
  }),
}))

const { landTaskCardFirstTurn, TASK_CARD_DISPATCH, TASK_CARD_NOT_MEMBER_HINT } = await import('../../../../apps/desktop/electron/sessionpage/task-card-first-turn')
const CARD = 'msg:00000000-0000-4000-8000-000000000004'

function land(chatId: string, text = '  登录页闪一下，看看为什么  ') {
  return landTaskCardFirstTurn({
    auth: { accessToken: 'token', userId: 'owner-1' },
    sessionId: 'session-1',
    projectId: 'project-1',
    agentUserId: 'agent-7',
    chatId,
    messageId: '00000000-0000-4000-8000-000000000004',
    text,
    deviceId: 'device-1',
    machineLabel: 'Mac Studio',
    senderIdentities: new Map([['owner-1', { guguNumber: 1001, displayName: '主人' }]]),
    timestamp: '2026-10-22 20:00',
    env: {},
    groupRulesLedger: ledger,
  })
}

beforeEach(() => {
  chats.clear()
  writes.length = 0
  awaited.length = 0
  rpcs.length = 0
  factReads.length = 0
  pendingRequests.clear()
  factsHidden.clear()
  ledger = memoryGroupRulesLedger()
})

describe('task card first turn (gugu-dev#181)', () => {
  it('writes the owner\'s card once the identity settled, names nobody, and hands the agent the group envelope', async () => {
    chats.set('00000000-0000-4000-8000-000000000001', { kind: 'group', public_id: 4242, name: '官网', members: ['owner-1', 'agent-7'] })
    const turn = await land('00000000-0000-4000-8000-000000000001')
    expect(awaited).toEqual(['agent-7'])
    expect(writes).toHaveLength(1)
    const write = writes[0]!
    expect(write).toMatchObject({ p_message_id: '00000000-0000-4000-8000-000000000004', p_chat_id: '00000000-0000-4000-8000-000000000001', p_sender_user_id: 'owner-1', p_to_user_ids: [], p_content_type: 'card' })
    expect(parseComposerCard(write.p_content as string)).toEqual({
      v: 1, type: 'task', text: '登录页闪一下，看看为什么', agentUserId: 'agent-7', agentName: 'Claude 7',
      // Who took it, as everyone who sees the card draws it (80e: a colleague could not look the agent up yet).
      agentType: 'claude-code', agentAvatar: LOOK,
      sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'Mac Studio',
    })
    const rendered = renderFirstTurn('登录页闪一下，看看为什么', turn.render)
    expect(rendered.origin).toBe('communication')
    expect(turn.chatId).toBe('00000000-0000-4000-8000-000000000001')
    expect(rendered.text).toContain(CARD)
    expect(rendered.text).toContain('登录页闪一下，看看为什么')
    // The card names nobody, so the envelope itself says it is the agent's task and where the answer goes.
    expect(rendered.text).toContain(`<message_context><![CDATA[${TASK_CARD_DISPATCH}\n在本群回复并引用这张卡（reply_to_message_id = ${CARD}）。]]></message_context>`)
    expect(rendered.text).not.toContain(TASK_CARD_NOT_MEMBER_HINT)
    // No rules in this group: the envelope says so as a fact, carries no rules text, records nothing.
    expect(rendered.text).toContain('rules="none"')
    expect(rendered.text).not.toContain('<group_rules')
    expect(await ledger.read('agent-7', '00000000-0000-4000-8000-000000000001')).toBeNull()
    expect(factReads).toEqual([{ p_chat_id: '00000000-0000-4000-8000-000000000001', p_as_user_id: 'agent-7' }])
    // A group (project group or not) keeps the agent's seat as it is and opens no topic.
    expect(rpcs).toEqual([])
  })

  it('a group with rules: the first turn carries them whole, and they are recorded so the first send goes through', async () => {
    const rules = '只在被 @ 时发言。\n回复用中文，三行以内。'
    chats.set('00000000-0000-4000-8000-000000000006', { kind: 'group', public_id: 9, name: '有规矩的群', members: ['owner-1', 'agent-7'], rules })
    // Whatever an earlier session of this agent left in the ledger, a first turn is a fresh context.
    await ledger.write('agent-7', '00000000-0000-4000-8000-000000000006', { version: groupRulesVersion(rules), contextKey: 'old-session:old-provider' })
    const turn = await land('00000000-0000-4000-8000-000000000006')
    const rendered = renderFirstTurn('登录页闪一下，看看为什么', turn.render)
    const version = groupRulesVersion(rules)
    expect(rendered.text).toContain(`rules="${version}"`)
    expect(rendered.text).toContain(`<group_rules version="${version}"><![CDATA[${rules}]]></group_rules>`)
    expect(rendered.text).toContain(TASK_CARD_DISPATCH)
    // message_send's gate reads the version; the entry names no provider context, so the reader's next delivery
    // from this room (keyed `<session>:<provider>`) carries the rules once more instead of never.
    expect(await ledger.read('agent-7', '00000000-0000-4000-8000-000000000006')).toEqual({ version, contextKey: null })
  })

  it('fails loud when a seated agent cannot see its own room\'s facts, rather than telling it there are no rules', async () => {
    // Seated by the owner's read, invisible to the agent's own read: the two disagree, so nothing is claimed.
    chats.set('00000000-0000-4000-8000-000000000007', { kind: 'group', public_id: 10, name: '看不见', members: ['owner-1', 'agent-7'], rules: '规矩' })
    factsHidden.add('00000000-0000-4000-8000-000000000007')
    await expect(land('00000000-0000-4000-8000-000000000007')).rejects.toThrow(/chat_facts has no row/)
    expect(await ledger.read('agent-7', '00000000-0000-4000-8000-000000000007')).toBeNull()
  })

  it('an agent not in the group yet (approval pending) is told to answer in its own session', async () => {
    chats.set('00000000-0000-4000-8000-000000000002', { kind: 'group', public_id: 7, name: '别人的群', members: ['owner-1'] })
    pendingRequests.add('00000000-0000-4000-8000-000000000002')
    const turn = await land('00000000-0000-4000-8000-000000000002')
    expect(writes).toHaveLength(1)
    const rendered = renderFirstTurn('登录页闪一下，看看为什么', turn.render)
    expect(rendered.origin).toBe('communication')
    expect(rendered.text).toContain(`<message_context><![CDATA[${TASK_CARD_DISPATCH}\n${TASK_CARD_NOT_MEMBER_HINT}你的入群申请正在等待群管理员同意。]]></message_context>`)
    // It cannot post there and cannot see the room yet: no reply instruction, no rules claimed either way.
    expect(rendered.text).not.toContain('reply_to_message_id =')
    expect(rendered.text).not.toContain('rules="')
    expect(factReads).toEqual([])
  })

  it('a full group without a pending request never claims that approval will let the agent in', async () => {
    chats.set('00000000-0000-4000-8000-000000000005', { kind: 'group', public_id: 8, name: 'Full group', members: ['owner-1'] })
    const turn = await land('00000000-0000-4000-8000-000000000005')
    const rendered = renderFirstTurn('登录页闪一下，看看为什么', turn.render)
    expect(rendered.origin).toBe('communication')
    expect(rendered.text).toContain(TASK_CARD_NOT_MEMBER_HINT)
    expect(rendered.text).not.toContain('等待群管理员同意')
    expect(rendered.text).not.toContain('要等群主同意')
  })

  it('in a direct chat with a person the card stays there and the agent gets the plain words', async () => {
    chats.set('00000000-0000-4000-8000-000000000003', { kind: 'dm', public_id: null, name: null, members: ['owner-1', 'friend-1'] })
    const turn = await land('00000000-0000-4000-8000-000000000003')
    expect(writes).toHaveLength(1)
    expect(turn).toEqual({ chatId: '00000000-0000-4000-8000-000000000003', render: { kind: 'plain' } })
    expect(renderFirstTurn('登录页闪一下，看看为什么', turn.render)).toEqual({ text: '登录页闪一下，看看为什么', origin: 'manual' })
  })

  it('fails loud when the chat is not visible to the owner, before writing anything', async () => {
    await expect(land('missing')).rejects.toThrow(/not visible/)
    expect(writes).toHaveLength(0)
  })
})
