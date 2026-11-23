// @vitest-environment jsdom
//
// @@@5856 话题(topic)展示层的判据 —— product spec。
// 覆盖两条承重线:
//   1. 「可见 / 参与 / 通知是三件事」在锚点卡上真的看得出来(is_participant=false ⇒ 「仅可查看」);
//      判据能判假 —— 同一份数据把 is_participant 翻成 true,那条断言必须反过来。
//   2. useTopicsOfChat 的竞态守卫:切线之后,上一条线的慢响应 ❌ 不许落进新线的状态。
import { readFile } from 'node:fs/promises'
import { act, createElement, useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as attachmentReader from '../../../apps/desktop/src/lib/attachmentBytes'
import { followRendererSession, queryClient as attachmentQueryClient } from '../../../apps/desktop/src/lib/replica'

import type { TopicSummary } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness, clickElement, deferred } from '../../support/testHarness'

const listTopicsOfChat = vi.fn<(sourceChatId: string) => Promise<TopicSummary[]>>()
vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    listTopicsOfChat: (sourceChatId: string) => listTopicsOfChat(sourceChatId),
  },
}))

// The server's send-time wakes: the receipt's own message woke its mentioned agent.
vi.mock('../../../apps/desktop/src/lib/chatMessageRevalidation', async (importOriginal) => ({
  ...await importOriginal<object>(),
  loadMessageAgentWakes: async (ids: string[]) => new Map(ids.map((id) => [id, new Set(id === 'topic-own-message' ? ['read'] : [])])),
}))

const { useTopicsOfChat, topicsSourceChatId } = await import('../../../apps/desktop/src/hooks/useTopics')
const { TopicAnchorCard } = await import('../../../apps/desktop/src/components/chat/TopicAnchorCard')
const { canSourceTopic } = await import('../../../apps/desktop/src/components/chat/topicAnchorModels')
const { chatDisplayName } = await import('@gugu/core/shared/ui/chatModels')
const { withSourceLineCandidates } = await import('../../../apps/desktop/src/lib/mention')

function topic(overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    chat_id: 'topic-1',
    name: '分片下载失败',
    source_message_id: 'msg-1',
    creator_user_id: 'user-1',
    last_message_at: '2026-09-18T00:00:00.000Z',
    message_count: 7,
    participant_count: 3,
    is_participant: true,
    ...overrides,
  }
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  listTopicsOfChat.mockReset()
  attachmentQueryClient.clear()
  vi.spyOn(attachmentReader, 'attachmentMetadata').mockResolvedValue({ status: 'ready', revision: { source: 'managed-object', file_name: 'fixture.pdf', content_type: 'application/pdf', size_bytes: 3, sha256: 'ab'.repeat(32) } })
  vi.stubGlobal('IntersectionObserver', class {
    constructor(private callback: (entries: { isIntersecting: boolean }[]) => void) {}
    observe() { this.callback([{ isIntersecting: true }]) }
    disconnect() {}
  })
  harness = createReactHarness()
})
afterEach(() => { harness.cleanup(); attachmentQueryClient.clear(); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('TopicAnchorCard 把「可见 / 参与 / 通知」的第三件显形', () => {
  it('非参与者的话题挂出「仅可查看」，参与者的不挂', async () => {
    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({ is_participant: false })], isMine: false, sourceContent: null, onOpen: vi.fn() }),
    )
    const observer = harness.container.querySelector('[data-testid="topic-anchor-observer"]')
    // 判据能判假:同一份数据只翻 is_participant,下面那次渲染必须拿不到这枚标。
    expect(observer).not.toBeNull()
    expect(observer?.textContent).toBe('仅可查看')
    expect(harness.container.querySelector('[data-testid="topic-anchor-row"]')?.getAttribute('data-topic-participant')).toBe('false')

    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({ is_participant: true })], isMine: false, sourceContent: null, onOpen: vi.fn() }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-observer"]')).toBeNull()
    expect(harness.container.textContent).not.toContain('仅可查看')
    expect(harness.container.querySelector('[data-testid="topic-anchor-row"]')?.getAttribute('data-topic-participant')).toBe('true')
  })

  it('一条来源消息长出的多条话题各渲染一行，点击回传话题 chat_id', async () => {
    const onOpen = vi.fn()
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ chat_id: 'topic-a' }), topic({ chat_id: 'topic-b', name: '网关限流' })],
        isMine: false,
        sourceContent: null,
        onOpen,
      }),
    )
    const rows = harness.container.querySelectorAll('[data-testid="topic-anchor-row"]')
    expect(rows.length).toBe(2)
    expect(harness.container.querySelector('[data-testid="topic-anchor-meta"]')?.textContent).toContain('7 条')
    await clickElement(rows[1] as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('topic-b')
  })

  it('没有话题时整块不渲染（❌ 不给消息底下留一条空壳）', async () => {
    await harness.render(createNode(TopicAnchorCard, { topics: [], isMine: false, sourceContent: null, onOpen: vi.fn() }))
    expect(harness.container.querySelector('[data-testid="topic-anchor-card"]')).toBeNull()
  })

  it('#6010 每条摘要显示自身参与人数，与消息数和是否参与无关，人数变化后更新', async () => {
    const onOpen = vi.fn()
    const render = (count: number) => harness.render(createNode(TopicAnchorCard, {
      topics: [topic({ participant_count: count, message_count: 33, is_participant: false }),
        topic({ chat_id: 'topic-2', name: '另一条话题', participant_count: 1, message_count: 0 })],
      isMine: false, sourceContent: null, onOpen,
    }))
    for (const count of [3, 4, 2, 0]) {
      await render(count)
      const rows = harness.container.querySelectorAll('[data-testid="topic-anchor-row"]')
      expect(rows[0]?.querySelector('[data-testid="topic-anchor-participant-count"]')?.textContent).toBe(`${count} 人参与`)
      expect(rows[0]?.querySelector('[data-testid="topic-anchor-meta"]')?.textContent).toContain('33 条')
      expect(rows[0]?.querySelector('[data-testid="topic-anchor-observer"]')).not.toBeNull()
      expect(rows[1]?.querySelector('[data-testid="topic-anchor-participant-count"]')?.textContent).toBe('1 人参与')
      expect(rows[0]?.getAttribute('aria-label')).toContain(`${count} 人参与`)
    }
    await clickElement(harness.container.querySelector('[data-topic-id="topic-2"]') as HTMLElement)
    expect(onOpen).toHaveBeenCalledWith('topic-2')
  })
})

// @@@5856 owner 2026-09-19 看了实机:旧样式在 UI 上不成立
// 「话题只是某一条消息的附件的思路你懂不,之前给你发的 discord 你倒是参考啊」。
describe('锚点是那条消息的附件,所以跟它的气泡同一侧', () => {
  it('自己发的消息 → 锚点贴右;别人发的 → 贴左', async () => {
    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({})], isMine: true, sourceContent: null, onOpen: vi.fn() }),
    )
    // 上一版恒定左对齐、整行铺开:来源消息在右边时,锚点跑到屏幕另一侧,读者连不起来它挂在谁身上。
    expect(harness.container.querySelector('[data-testid="topic-anchor-card"]')?.getAttribute('data-topic-anchor-side')).toBe('mine')

    await harness.render(
      createNode(TopicAnchorCard, { topics: [topic({})], isMine: false, sourceContent: null, onOpen: vi.fn() }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-card"]')?.getAttribute('data-topic-anchor-side')).toBe('theirs')
  })

  it('那一行说清「谁开的 · 什么时候有动静」;都没有就明说暂无消息,❌ 不留一行空的', async () => {
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ creator_user_id: 'u1', last_message_at: '2026-09-18T12:00:00.000Z' })],
        isMine: false,
        sourceContent: '来源那句话',
        onOpen: vi.fn(),
        memberProfiles: { u1: { displayName: '林工' } },
      }),
    )
    const meta = harness.container.querySelector('[data-testid="topic-anchor-meta"]')?.textContent ?? ''
    expect(meta).toContain('林工')

    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ creator_user_id: null, last_message_at: null, message_count: 0 })],
        isMine: false,
        sourceContent: '来源那句话',
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-meta"]')?.textContent).toBe('暂无消息')
  })

  // @@@5856 owner 2026-09-19 对着实机:「你不感觉这个像是个文字重复吗?这一段文字,是你故意的」。
  // 话题名默认截自来源消息的开头,锚点又挂在那条消息底下 ⇒ 同一句话连着出现两遍。
  // 判据两面都要:没改过名不许重复,改过名必须写出来(否则「永远只写『话题』」也能过)。
  it('名字还是从来源消息截出来的 ⇒ 锚点不把那句话念第二遍;改过名才写名字', async () => {
    const source = '分片下载在弱网下会整包重来，这个得单独拉一条线捋'
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: source })],
        isMine: true,
        sourceContent: source,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('话题')
    expect(harness.container.textContent).not.toContain('整包重来')

    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: '弱网续传' })],
        isMine: true,
        sourceContent: source,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('弱网续传')
  })

  it('超过 40 字的来源消息:名字带省略号,客户端这份镜像照样认得出它没被改过', async () => {
    const source = `${'长'.repeat(60)}\n第二行不算`
    const cut = `${'长'.repeat(40)}…`
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: cut })],
        isMine: false,
        sourceContent: source,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('话题')
  })

  it('取不到来源正文时宁可把名字写出来,❌ 不隐瞒', async () => {
    await harness.render(
      createNode(TopicAnchorCard, {
        topics: [topic({ name: '某条话题' })],
        isMine: false,
        sourceContent: null,
        onOpen: vi.fn(),
      }),
    )
    expect(harness.container.querySelector('[data-testid="topic-anchor-lead"]')?.textContent).toBe('某条话题')
  })
})

describe('@@@5856 「这条消息开得出话题吗」只有一个判据,顶栏与右键共用', () => {
  const base = { id: 'm', seq: 1, local_send_state: undefined, is_whisper: false, retracted_at: null, content_type: 'text' } as Parameters<typeof canSourceTopic>[0]
  it('发送中等来源送达;未送达、悄悄话与已撤回不能开话题', () => {
    expect(canSourceTopic(base)).toBe(true)
    expect(canSourceTopic({ ...base, seq: -1 })).toBe(true)
    expect(canSourceTopic({ ...base, local_send_state: 'sending' })).toBe(true)
    expect(canSourceTopic({ ...base, local_send_state: 'failed' })).toBe(false)
    expect(canSourceTopic({ ...base, is_whisper: true })).toBe(false)
    expect(canSourceTopic({ ...base, retracted_at: new Date().toISOString() })).toBe(false)
    // 系统消息与附件服务端是收的(名字回落成「话题」)⇒ 客户端也收,❌ 不许比服务端严。
    expect(canSourceTopic({ ...base, content_type: 'system' })).toBe(true)
    expect(canSourceTopic({ ...base, content_type: 'attachment' })).toBe(true)
  })

  it('右键菜单与顶栏按钮走的是同一个函数,❌ 不各写一份', async () => {
    // 找茬第八轮:右键那边只挡了悄悄话和撤回,于是在发失败的红气泡上还能点「开话题」,
    // 点完服务端必拒(is not a live message),界面只给一句帮不上忙的 toast。
    const bubble = await readFile('apps/desktop/src/components/chat/MessageBubble.tsx', 'utf8')
    expect(bubble).toContain("import { canSourceTopic } from './topicAnchorModels'")
    // 悬停条 ⋯、右键菜单、手机长按面板三处的动作都出自同一个 messageActions ⇒ 判据只写一次,三处都从它拿。
    expect(bubble.match(/onOpenTopic && canSourceTopic\(msg\)/g)).toHaveLength(1)
    expect(bubble.match(/\{\.\.\.messageActions\(/g)).toHaveLength(3)
    expect(bubble).not.toContain('onOpenTopic && !msg.is_whisper')
  })
})

describe('一条会话在界面上叫什么(会话列表 / 转发目标 / 话题面包屑读同一份)', () => {
  it('场所用自己的名字,dm/ai 用对端', () => {
    expect(chatDisplayName({ kind: 'topic', name: '分片下载失败', peer_alias: null }, undefined)).toBe('分片下载失败')
    expect(chatDisplayName({ kind: 'group', name: '发版群', peer_alias: null }, undefined)).toBe('发版群')
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: null }, '小明')).toBe('小明')
  })

  it('备注压过对端本名', () => {
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: '  老王  ' }, '王某某')).toBe('老王')
  })

  it('场所名为空时用兜底名 —— 空串会让这一行在列表里消失、在转发框里搜不到', () => {
    expect(chatDisplayName({ kind: 'topic', name: '', peer_alias: null }, undefined)).toBe('话题')
    expect(chatDisplayName({ kind: 'topic', name: '   ', peer_alias: null }, undefined)).toBe('话题')
  })

  it('❌ dm/ai 的对端解析不出来时必须是空串,不许拿兜底名冒充(#1623 / #1624)', () => {
    // 假名字会把「对端解析失败」这个 bug 藏起来:#1623 就是一条 agent 私聊安静地画成「聊天」。
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: null }, undefined)).toBe('')
    expect(chatDisplayName({ kind: 'ai', name: '', peer_alias: null }, undefined)).toBe('')
    expect(chatDisplayName({ kind: 'dm', name: '', peer_alias: null }, '  ')).toBe('')
  })
})

describe('话题里能点名谁', () => {
  const identities = {
    'u-in': { display_name: '话题里的人', type: 'human' as const },
    'u-src': { display_name: '来源线的人', type: 'human' as const },
    'a-src': { display_name: 'Agent 甲', type: 'agent' as const },
    'u-noname': { display_name: '  ', type: 'human' as const },
  }
  const own = [{ id: 'u-in', name: '话题里的人', type: 'human' as const }]

  it('来源线的成员并进候选 —— 与服务端 is_addressable_in 对齐', () => {
    const got = withSourceLineCandidates(own, ['u-in', 'u-src', 'a-src'], identities)
    expect(got.map((c) => c.id)).toEqual(['u-in', 'u-src', 'a-src'])
  })

  it('已经在话题里的人不重复,身份解析不出名字的不进集合(名字是投递依据)', () => {
    const got = withSourceLineCandidates(own, ['u-in', 'u-noname', 'unknown-id'], identities)
    expect(got.map((c) => c.id)).toEqual(['u-in'])
  })

  it('没有来源线(群/私聊)时原样返回,❌ 不凭空多出候选', () => {
    expect(withSourceLineCandidates(own, undefined, identities)).toBe(own)
    expect(withSourceLineCandidates(own, [], identities)).toBe(own)
  })
})

describe('useTopicsOfChat', () => {
  // The topics are an account replica: it reads only for a signed-in account, as the product does.
  beforeEach(() => followRendererSession('SIGNED_IN', 'user-1'))
  let observed: { topics: TopicSummary[]; loading: boolean; error: string | null; byMessage: Map<string, TopicSummary[]> | null }
  let reload: () => void

  function Probe({ sourceChatId }: { sourceChatId: string | null }) {
    const state = useTopicsOfChat(sourceChatId)
    reload = state.reload
    useEffect(() => {
      observed = { topics: state.topics ?? [], loading: state.loading, error: state.error, byMessage: state.bySourceMessageId }
    })
    return null
  }

  it('切会话时旧响应 ❌ 不许覆盖新会话的状态', async () => {
    const slowA = deferred<TopicSummary[]>()
    const fastB = deferred<TopicSummary[]>()
    listTopicsOfChat.mockImplementation((chatId) => (chatId === 'chat-A' ? slowA.promise : fastB.promise))

    await harness.render(createElement(Probe, { sourceChatId: 'chat-A' }))
    expect(listTopicsOfChat).toHaveBeenCalledWith('chat-A')

    // 还没等 A 回来就切到 B。
    await harness.render(createElement(Probe, { sourceChatId: 'chat-B' }))
    expect(listTopicsOfChat).toHaveBeenCalledWith('chat-B')
    // 切线即清空:上一条线的话题不许在新线的首帧里留一拍。
    expect(observed.topics).toEqual([])

    await act(async () => {
      fastB.resolve([topic({ chat_id: 'topic-b', source_message_id: 'msg-b' })])
      await Promise.resolve()
    })
    expect(observed.topics.map((row) => row.chat_id)).toEqual(['topic-b'])

    // A 的慢响应现在才到 —— 没有守卫的话它会把 B 的状态盖掉。
    await act(async () => {
      slowA.resolve([topic({ chat_id: 'topic-a', source_message_id: 'msg-a' })])
      await Promise.resolve()
    })
    expect(observed.topics.map((row) => row.chat_id)).toEqual(['topic-b'])
    expect(observed.loading).toBe(false)
    expect([...observed.byMessage!.keys()]).toEqual(['msg-b'])
  })

  it('sourceChatId 为 null 时不请求（话题上不再开话题，单层不嵌套）', async () => {
    await harness.render(createElement(Probe, { sourceChatId: null }))
    expect(listTopicsOfChat).not.toHaveBeenCalled()
    expect(observed.topics).toEqual([])
    expect(observed.loading).toBe(false)
    // 单层不嵌套的守卫在调用点:话题会话本身 → null。
    expect(topicsSourceChatId({ id: 'topic-1', kind: 'topic' })).toBeNull()
    expect(topicsSourceChatId({ id: 'group-1', kind: 'group' })).toBe('group-1')
    expect(topicsSourceChatId(null)).toBeNull()
  })

  it('bySourceMessageId 把同一条来源消息的多条话题归一组；reload 重新取', async () => {
    listTopicsOfChat.mockResolvedValue([
      topic({ chat_id: 'topic-a', source_message_id: 'msg-1' }),
      topic({ chat_id: 'topic-b', source_message_id: 'msg-1' }),
      topic({ chat_id: 'topic-c', source_message_id: 'msg-2' }),
    ])
    await harness.render(createElement(Probe, { sourceChatId: 'chat-A' }))
    await act(async () => { await Promise.resolve() })
    expect(observed.byMessage!.get('msg-1')?.map((row) => row.chat_id)).toEqual(['topic-a', 'topic-b'])
    expect(observed.byMessage!.get('msg-2')?.map((row) => row.chat_id)).toEqual(['topic-c'])

    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
    await act(async () => { reload(); await Promise.resolve() })
    expect(listTopicsOfChat).toHaveBeenCalledTimes(2)
  })

  it('列不出来就说列不出来，❌ 不静默当成「这条线上没有话题」', async () => {
    listTopicsOfChat.mockRejectedValue(new Error('permission denied for function list_topics_of_chat'))
    await harness.render(createElement(Probe, { sourceChatId: 'chat-A' }))
    await act(async () => { await Promise.resolve() })
    expect(observed.error).toContain('permission denied')
    expect(observed.loading).toBe(false)
  })
})

// @@@5856 会话列表里「话题挂在来源线底下」的两条规则 + 「开成分栏」那条请求的收发。
//
// owner 2026-09-19:「怎么还有把一个 topic 当做群的形式表达,我前面提的 7 个问题,不是让你改了吗」
// 这一组钉的是**我上一版真的做错了的三件事**:
//   ① 话题占了一行平级的会话(他截图框的就是这个)。
//   ② 点子行毫无反应 —— 请求在聊天区挂载之前发出去,没人接,丢了。
//   ③ 分栏是 subject-scoped 的:点下去那一刻主区显示的还是上一条线,当场开分栏会记到旧线名下,
//      切过去之后立刻不显示,看起来还是「点了没反应」。
describe('会话列表:话题是来源线的子行,不是一行平级的会话', () => {
  type Row = {
    id: string; kind: string; name: string
    source_chat_id?: string | null; last_message_at?: string
    is_pinned?: boolean; is_marked_unread?: boolean; unread_count?: number
  }
  const chat = (id: string, over: Partial<Row> = {}): Row =>
    ({ id, kind: 'group', name: id, last_message_at: '2026-09-19T00:00:00Z', unread_count: 0, ...over })
  const topicRow = (id: string, source: string, over: Partial<Row> = {}): Row =>
    chat(id, { kind: 'topic', source_chat_id: source, ...over })
  const byTime = (a: Row, b: Row) => (b.last_message_at ?? '').localeCompare(a.last_message_at ?? '')
  const all = () => true
  const allListed = () => true
  const nest = async () => import('../../../apps/desktop/src/components/chatListTopicNesting')

  it('话题按来源线归组，并且永远不占一行顶层', async () => {
    const { groupTopicsBySource, isTopLevelChatRow } = await nest()
    const rows = [chat('g1'), topicRow('t1', 'g1'), chat('g2'), topicRow('t2', 'g1'), topicRow('t3', 'g2')]
    const nesting = groupTopicsBySource(rows as never, all, byTime as never, allListed)
    expect(nesting.bySource.get('g1')?.map((r) => r.id)).toEqual(['t1', 't2'])
    expect(nesting.bySource.get('g2')?.map((r) => r.id)).toEqual(['t3'])
    for (const row of rows) {
      expect(isTopLevelChatRow(row as never, nesting, all, all)).toBe(row.kind !== 'topic')
    }
  })

  it('来源线底下的子行：置顶的话题排在没置顶的前面，再按时间', async () => {
    const { groupTopicsBySource } = await nest()
    const rows = [chat('g1'), topicRow('new', 'g1', { last_message_at: '2026-11-03T00:00:00Z' }), topicRow('mid', 'g1', { last_message_at: '2026-11-02T00:00:00Z' }), topicRow('old', 'g1', { last_message_at: '2026-11-01T00:00:00Z', is_pinned: true })]
    const nesting = groupTopicsBySource(rows as never, all, byTime as never, allListed)
    expect(nesting.bySource.get('g1')?.map((r) => r.id)).toEqual(['old', 'new', 'mid'])
  })

  it('溯源指针缺失的话题不归到任何一条线下（❌ 也不因此凭空消失）', async () => {
    const { groupTopicsBySource, isTopLevelChatRow } = await nest()
    const orphan = topicRow('t-orphan', 'g1', { source_chat_id: null })
    const nesting = groupTopicsBySource([chat('g1'), orphan] as never, all, byTime as never, allListed)
    expect(nesting.bySource.size).toBe(0)
    // 挂不上去 ⇒ 退回顶层。人还在这条话题里、它照样给人发通知,❌ 不许从列表上蒸发。
    expect(isTopLevelChatRow(orphan as never, nesting, all, all)).toBe(true)
  })

  // @@@5856 找茬第十轮的阻断:群主把来源群解散/归档之后,我仍是话题成员、话题仍 active、
  // 消息照样通知我,但子行没地方挂 ⇒ 两条话题一起从列表上消失,连搜都搜不到。
  it('来源线被归档/已退出:它底下的话题退回顶层，❌ 不许跟着一起消失', async () => {
    const { groupTopicsBySource, isTopLevelChatRow, splitSunkTopics } = await nest()
    const archived = chat('发版群')
    const t1 = topicRow('分片下载', '发版群')
    const listed = (row: { id: string }) => row.id !== '发版群'
    const nesting = groupTopicsBySource(
      [archived, t1] as never, (row) => listed(row), byTime as never,
      (sourceId) => listed({ id: sourceId }),
    )
    expect(nesting.bySource.size).toBe(0)
    expect(isTopLevelChatRow(t1 as never, nesting, listed as never, all)).toBe(true)
    // 反例:来源线还在时它就该老老实实当子行,❌ 不许两头都出现。
    const healthy = groupTopicsBySource([archived, t1] as never, all, byTime as never, allListed)
    expect(isTopLevelChatRow(t1 as never, healthy, all, all)).toBe(false)
    expect(splitSunkTopics(healthy.bySource.get('发版群') ?? [], () => false).live.map((r) => r.id))
      .toEqual(['分片下载'])
  })

  it('搜到的是话题、来源线一个字都不匹配时，来源线照样占一行 —— 否则那条话题无处可挂', async () => {
    const { groupTopicsBySource, isTopLevelChatRow } = await nest()
    const source = chat('发版群')
    const hit = topicRow('分片下载', '发版群')
    const miss = chat('别的群')
    const matchesSearch = (row: { id: string }) => row.id === '分片下载'
    const nesting = groupTopicsBySource(
      [source, hit, miss] as never, matchesSearch as never, byTime as never, allListed)
    expect(nesting.bySource.get('发版群')?.map((r) => r.id)).toEqual(['分片下载'])
    // 正例与反例都要:命中了才留,没命中也没有子行的照样被搜索筛掉。
    expect(isTopLevelChatRow(source as never, nesting, all, matchesSearch as never)).toBe(true)
    expect(isTopLevelChatRow(miss as never, nesting, all, matchesSearch as never)).toBe(false)
  })

  // @@@5856 找茬第十轮的阻断:isSunkTopic 只对 kind==='topic' 为真,而话题永不占顶层 ⇒
  // 列表底部那个「更早」分段恒空,沉降在产品里整个死掉了(spec:「没有开关,只有沉降」)。
  // 沉降必须发生在**子行**这一层。
  it('沉降发生在子行这一层：静了太久的收进「更早」，活着的照常显示', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    const live = topicRow('活的', 'g1', { last_message_at: '2026-09-19T00:00:00Z' })
    const old = topicRow('沉了的', 'g1', { last_message_at: '2026-08-01T00:00:00Z' })
    const nesting = groupTopicsBySource([chat('g1'), live, old] as never, all, byTime as never, allListed)
    const isSunk = (row: { id: string }) => row.id === '沉了的'
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], isSunk as never)
    expect(split.live.map((r) => r.id)).toEqual(['活的'])
    expect(split.sunk.map((r) => r.id)).toEqual(['沉了的'])
    // 反例:一条都没沉时不许凭空冒出「更早」那一行。
    expect(splitSunkTopics(nesting.bySource.get('g1') ?? [], () => false).sunk).toEqual([])
  })

  // owner 2026-09-20 实测后将每条来源线的上限收至 3 条。
  it('子行最多摊开 3 条,多出来的并进同一个「更多」——❌ 不是消失,也❌ 不另加一个折叠控件', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    // 从新到旧 8 条;byTime 把它们排成 t8…t1。
    const rows = Array.from({ length: 8 }, (_, index) => topicRow(
      `t${index + 1}`, 'g1', { last_message_at: `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00Z` },
    ))
    const nesting = groupTopicsBySource([chat('g1'), ...rows] as never, all, byTime as never, allListed)
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], () => false)
    expect(split.live).toHaveLength(3)
    expect(split.live.map((r) => r.id)).toEqual(['t8', 't7', 't6'])
    // 多出来的五条进「更多」,一条都不许丢。
    expect(split.sunk.map((r) => r.id)).toEqual(['t5', 't4', 't3', 't2', 't1'])
    // 阳控:刚好 3 条时不显示「更多」。
    const few = groupTopicsBySource([chat('g2'), ...rows.slice(0, 3).map((r) => ({ ...r, source_chat_id: 'g2' }))] as never, all, byTime as never, allListed)
    expect(splitSunkTopics(few.bySource.get('g2') ?? [], () => false).sunk).toEqual([])
  })

  it('条数与时间两道并存:先按时间沉,再按条数收,「更早」里时间序不乱', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    const rows = Array.from({ length: 7 }, (_, index) => topicRow(
      `u${index + 1}`, 'g1', { last_message_at: `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00Z` },
    ))
    const nesting = groupTopicsBySource([chat('g1'), ...rows] as never, all, byTime as never, allListed)
    // u1 静太久 ⇒ 时间沉;剩下六条里只摊开三条,溢出的三条排在时间沉的前面(它们更新)。
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], ((row: { id: string }) => row.id === 'u1') as never)
    expect(split.live.map((r) => r.id)).toEqual(['u7', 'u6', 'u5'])
    expect(split.sunk.map((r) => r.id)).toEqual(['u4', 'u3', 'u2', 'u1'])
  })

  // 角标数的是未读;有未读的话题若被条数上限并进「更多」,角标就清不掉(owner 10-19 现场:总群第 5 条话题 3 条未读)。
  it('有未读的话题不受 3 条上限，读完就回到上限之内', async () => {
    const { groupTopicsBySource, splitSunkTopics } = await nest()
    const rows = Array.from({ length: 5 }, (_, index) => topicRow(
      `v${index + 1}`, 'g1', { last_message_at: `2026-09-${String(10 + index).padStart(2, '0')}T00:00:00Z`, unread_count: index === 0 ? 3 : 0 },
    ))
    const nesting = groupTopicsBySource([chat('g1'), ...rows] as never, all, byTime as never, allListed)
    const split = splitSunkTopics(nesting.bySource.get('g1') ?? [], () => false)
    expect(split.live.map((r) => r.id)).toEqual(['v5', 'v4', 'v3', 'v1'])
    expect(split.sunk.map((r) => r.id)).toEqual(['v2'])
    // 阴控:同一条读完(unread_count 0)就照常按条数收进「更多」。
    const read = rows.map((r) => ({ ...r, unread_count: 0 }))
    const after = splitSunkTopics(groupTopicsBySource([chat('g1'), ...read] as never, all, byTime as never, allListed).bySource.get('g1') ?? [], () => false)
    expect(after.live.map((r) => r.id)).toEqual(['v5', 'v4', 'v3'])
    expect(after.sunk.map((r) => r.id)).toEqual(['v2', 'v1'])
  })

  it('more reveals all read and old topics inline in the original order', async () => {
    const { splitSunkTopics } = await nest()
    const rows = Array.from({ length: 200 }, (_, index) => topicRow(`p${index}`, 'g1'))
    expect(splitSunkTopics(rows as never, () => false).live).toHaveLength(3)
    expect(splitSunkTopics(rows as never, () => true, undefined, true)).toEqual({ live: rows, sunk: [] })
  })

})
