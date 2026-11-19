// gugu-dev#181 ⑨:agent 问自群里的那一句(session_ask_user 带的 source_link 指向群里一条),问题卡以这个 agent 的身份进那个群、
// 引用那一条;消息 id 就是问题自己的 uuid(重放收敛到同一条)。私聊不发(它的对话页已经在画这道题);卡没发出去,问题照样在等,结果里说一句。
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parseComposerCard } from '../../../../packages/core/src/shared/ui/taskCardModels'

const kinds = new Map<string, string>()
const writes: Array<Record<string, unknown>> = []
const posting = vi.fn()
let writeError: { message: string } | null = null

vi.mock('../../../../apps/desktop/electron/supabase', () => ({
  makeChatClient: () => ({
    from: () => {
      const filters: Record<string, string> = {}
      const query = {
        select: () => query,
        eq: (column: string, value: string) => { filters[column] = value; return query },
        maybeSingle: async () => ({ data: kinds.has(filters.id ?? '') ? { kind: kinds.get(filters.id ?? '') } : null, error: null }),
      }
      return query
    },
    rpc: async (name: string, args: Record<string, unknown>) => {
      if (name !== 'send_message_idempotent') throw new Error(`unexpected rpc ${name}`)
      expect(posting).toHaveBeenLastCalledWith(`agent-question:${QUESTION}`, { chatId: args.p_chat_id, messageId: QUESTION, ownerUserId: 'owner-1' })
      writes.push(args)
      return { error: writeError }
    },
  }),
}))

const { withQuestionCard } = await import('../../../../apps/desktop/electron/sessionpage/question-card')

const GROUP = '11111111-1111-4111-8111-111111111111'
const DM = '22222222-2222-4222-8222-222222222222'
const SOURCE = '33333333-3333-4333-8333-333333333333'
const QUESTION = '44444444-4444-4444-8444-444444444444'
const ask = (chatId: string, questions: unknown, agentUserId: string | null = 'agent-7') => withQuestionCard({
  auth: { accessToken: 'token', userId: 'owner-1' },
  caller: { agentUserId, deviceId: 'device-1', deviceLabel: 'Mac Studio', sessionId: 'session-1' },
  projectId: 'project-1',
  asked: { state: 'pending', question_id: `agent-question:${QUESTION}`, source_link: `gugu-chat://${chatId}/${SOURCE}` },
  questions,
  onPosting: posting,
})
const one = [{ question: '要把初始化提前吗？', options: [{ label: '提前' }, { label: '先不动' }] }]

beforeEach(() => {
  kinds.clear(); kinds.set(GROUP, 'group'); kinds.set(DM, 'dm')
  writes.length = 0
  writeError = null
  posting.mockClear()
})

describe('a question asked from a group goes into that group (gugu-dev#181 ⑨)', () => {
  it('as the agent, quoting the message it was asked from, under the question\'s own id', async () => {
    expect(await ask(GROUP, one)).toMatchObject({ state: 'pending' })
    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({
      p_message_id: QUESTION, p_chat_id: GROUP, p_sender_user_id: 'agent-7', p_to_user_ids: [],
      p_content_type: 'card', p_reply_to_message_id: SOURCE,
    })
    expect(parseComposerCard(writes[0]!.p_content as string)).toEqual({
      v: 1, type: 'question', text: '要把初始化提前吗？', options: ['提前', '先不动'], ownerUserId: 'owner-1',
      questions: [{ question: one[0].question, multiSelect: false, options: one[0].options.map(option => ({ optionId: option.label, name: option.label })) }],
      questionId: `agent-question:${QUESTION}`, sessionId: 'session-1', projectId: 'project-1', deviceId: 'device-1', machineLabel: 'Mac Studio',
    })
  })

  it('retains legacy options for compatibility when several questions or multi-select require the full flow', async () => {
    await ask(GROUP, [...one, { question: '再问一道', options: [{ label: 'a' }, { label: 'b' }] }])
    await ask(GROUP, [{ ...one[0], multi_select: true }])
    expect(writes.map((write) => parseComposerCard(write.p_content as string))).toMatchObject([{ options: [] }, { options: [] }])
  })

  it.each(['dm', 'ai'])('a %s chat gets no duplicate card', async kind => {
    kinds.set(DM, kind)
    await ask(DM, one)
    expect(writes).toHaveLength(0)
    expect(posting).not.toHaveBeenCalled()
  })

  it.each(['group', 'topic'])('publishes every question, header and option description in a %s', async kind => {
    kinds.set(GROUP, kind)
    await ask(GROUP, [
      { ...one[0], header: '展示方式', options: [{ label: '聊天', description: '留在当前聊天回答' }] },
      { question: '覆盖哪里？', header: '范围', multi_select: true, options: [{ label: '群聊' }, { label: '话题', description: '跟随当前话题' }] },
      { question: '补充要求？', options: [] },
    ])
    expect(parseComposerCard(writes[0].p_content as string)).toMatchObject({
      v: 1, text: one[0].question, options: [], questions: [
        { question: one[0].question, header: '展示方式', multiSelect: false, options: [{ optionId: '聊天', name: '聊天', description: '留在当前聊天回答' }] },
        { question: '覆盖哪里？', header: '范围', multiSelect: true, options: [{ optionId: '群聊', name: '群聊' }, { optionId: '话题', name: '话题', description: '跟随当前话题' }] },
        { question: '补充要求？', multiSelect: false, options: [] },
      ],
    })
    expect(writes[0].p_content).toMatch(/^\{"v":1,"type":"question","text":/)
  })

  it('a card that cannot be posted leaves the question waiting, and says so', async () => {
    writeError = { message: 'denied' }
    expect(await ask(GROUP, one)).toMatchObject({ state: 'pending', group_card: { status: 'unavailable', error: 'write failed: denied' } })
    expect(await ask(GROUP, one, null)).toMatchObject({ state: 'pending', group_card: { status: 'unavailable' } })
  })
})
