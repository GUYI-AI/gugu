// @vitest-environment jsdom
//
// @@@5856 话题这一面的看不见但会坏的接线 —— product spec。
//   ① 别人在我正看的这条线上开了话题 ⇒ 当场读到那条话题(服务端给来源线成员发 chat_changed,
//      entity_id 是那条话题,gugu-supabase 20261106080000)。反例同样钉住:来源线自己的消息、别的线上开话题 ❌ 不许触发读取。
//   ② 话题是一条主会话(#62):打开的话题跟上自己的摘要,不论读者是不是参与者。
//   ③ 从消息开话题:建完就把它换成主会话。
import { chatWindowStub } from '../../support/chatWindowStub'
import { captureOpenedChats } from '../../support/openedChats'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatItem, MessageItem, TopicSummary } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness, message, renderWithAppProviders } from '../../support/testHarness'

const listTopicsOfChat = vi.fn<(sourceChatId: string, topicChatId?: string) => Promise<TopicSummary[]>>()
const onCreateFailed = vi.fn()
const createTopic = vi.fn()
const refreshLine = vi.fn<(chatId: string) => Promise<unknown>>()
let sourceMessages: MessageItem[]

vi.mock('../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    listTopicsOfChat: (sourceChatId: string, topicChatId?: string) => listTopicsOfChat(sourceChatId, topicChatId),
    createTopic: (...args: unknown[]) => createTopic(...args),
  },
}))

const { useTopicSurface } = await import('../../../apps/desktop/src/hooks/useTopicSurface')
type Surface = ReturnType<typeof useTopicSurface>

function topic(overrides: Partial<TopicSummary> = {}): TopicSummary {
  return {
    chat_id: 'topic-1', name: '分片下载失败', source_message_id: 'msg-1', creator_user_id: 'user-1',
    last_message_at: '2026-09-18T00:00:00.000Z', message_count: 1, participant_count: 1,
    is_participant: true, ...overrides,
  }
}

type RevisionListener = (operations: readonly { revision: string; event: string; payload: unknown }[]) => void | Promise<void>
let listeners: Map<string, Set<RevisionListener>>
const subscribeAccountRevision = (event: string, listener: RevisionListener) => {
  let bucket = listeners.get(event)
  if (!bucket) { bucket = new Set(); listeners.set(event, bucket) }
  bucket.add(listener)
  return () => { bucket.delete(listener) }
}
/** 载荷与 sync_since 同形(resource_key + tombstone);extra 补各事件自己的键。 */
async function emit(event: string, chatId: string, extra: Record<string, unknown> = {}) {
  await act(async () => {
    for (const listener of listeners.get(event) ?? []) await listener([{ revision: '1', event, payload: { chat_id: chatId, tombstone: false, ...extra } }])
    await Promise.resolve()
  })
}

let harness: ReturnType<typeof createReactHarness>
let surface: Surface | null
let opened: ReturnType<typeof captureOpenedChats>
function Probe({ chat }: { chat: Pick<ChatItem, 'id' | 'kind' | 'source_chat_id'> }) {
  surface = useTopicSurface({
    messages: sourceMessages,
    chat,
    lineSettled: true,
    refreshLine,
    subscribeAccountRevision,
    onCreateFailed,
  })
  return null
}

beforeEach(() => {
  listeners = new Map()
  sourceMessages = []
  createTopic.mockReset().mockResolvedValue({ chat_id: 'topic-1', name: 'Projected default' })
  surface = null
  listTopicsOfChat.mockReset().mockResolvedValue([topic()])
  refreshLine.mockReset().mockResolvedValue(undefined)
  onCreateFailed.mockReset()
  harness = createReactHarness()
  opened = captureOpenedChats()
})
afterEach(() => {
  harness.cleanup()
  opened.stop()
})

async function mount(chat: Pick<ChatItem, 'id' | 'kind' | 'source_chat_id'> = { id: 'chat-A', kind: 'group', source_chat_id: null }) {
  await renderWithAppProviders(harness, createNode(Probe, { chat }), { chat: { ...chatWindowStub(), createTopic } })
  await act(async () => { await Promise.resolve(); await Promise.resolve() })
}

describe('别人在这条线上开了话题,清单当场读到它', () => {
  it('来源线上话题的 chat_changed 只读那一条话题', async () => {
    await mount()
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
    await emit('chat_changed', 'chat-A', { entity_id: 'topic-1' })
    expect(listTopicsOfChat).toHaveBeenCalledTimes(2)
    expect(listTopicsOfChat).toHaveBeenLastCalledWith('chat-A', 'topic-1')
  })

  it('反例:来源线自己的 chat_changed(每条消息一次)❌ 不读话题', async () => {
    await mount()
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
    await emit('chat_changed', 'chat-A')
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
  })

  it('反例:别的线上的 chat_changed ❌ 不许重拉(否则上一条判据是死的)', async () => {
    await mount()
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
    await emit('chat_changed', 'some-other-chat', { entity_id: 'topic-9' })
    expect(listTopicsOfChat).toHaveBeenCalledTimes(1)
  })
})

describe('an open topic follows its summary for every reader, member or not', () => {
  // A source-line member who never spoke in the topic gets no message_created for its rows,
  // only the source line's chat_changed naming the topic. The open topic must still catch up to the new reply.
  it('refreshes the open topic once for a newer summary, however often the source line repeats it', async () => {
    const first = message({ id: 't1', chat_id: 'topic-1', seq: 1, created_at: '2026-09-18T00:00:00.000Z' })
    listTopicsOfChat.mockResolvedValue([topic({ is_participant: false, last_message_at: first.created_at })])
    sourceMessages = [first]
    await mount({ id: 'topic-1', kind: 'topic', source_chat_id: 'chat-A' })
    expect(listTopicsOfChat).toHaveBeenCalledWith('chat-A', undefined)
    expect(surface?.anchorsByMessageId).toBeNull()
    await emit('chat_changed', 'chat-A', { entity_id: 'topic-1' })
    expect(refreshLine).not.toHaveBeenCalled()
    listTopicsOfChat.mockResolvedValue([topic({ is_participant: false, last_message_at: '2026-09-18T00:01:00.000Z', message_count: 2 })])
    for (let i = 0; i < 3; i++) await emit('chat_changed', 'chat-A', { entity_id: 'topic-1' })
    expect(refreshLine).toHaveBeenCalledExactlyOnceWith('topic-1')
  })

  it('a group line never refreshes itself from its topics\' summaries', async () => {
    listTopicsOfChat.mockResolvedValue([topic({ last_message_at: '2026-09-18T00:05:00.000Z' })])
    await mount()
    await emit('chat_changed', 'chat-A', { entity_id: 'topic-1' })
    expect(refreshLine).not.toHaveBeenCalled()
  })
})

describe('#6010 摘要参与人数随来源线的失效通知更新', () => {
  it('非参与者也重读人数；加入、退出不依赖话题新消息，其他来源线不影响它', async () => {
    listTopicsOfChat.mockResolvedValue([topic({ participant_count: 1, is_participant: false })])
    await mount()
    expect(surface?.anchorsByMessageId?.get('msg-1')?.[0]?.participant_count).toBe(1)
    for (const count of [2, 1]) {
      listTopicsOfChat.mockResolvedValue([topic({ participant_count: count, is_participant: false })])
      await emit('chat_changed', 'chat-A', { entity_id: 'topic-1' })
      expect(surface?.anchorsByMessageId?.get('msg-1')?.[0]?.participant_count).toBe(count)
      expect(surface?.topics[0]?.is_participant).toBe(false)
    }
    expect(listTopicsOfChat).toHaveBeenCalledTimes(3)
    await emit('chat_changed', 'chat-B', { entity_id: 'topic-1' })
    expect(listTopicsOfChat).toHaveBeenCalledTimes(3)
    expect(refreshLine).not.toHaveBeenCalled()
  })
})

it('projects agent references before naming a topic and still recognizes the supplied name as automatic', async () => {
  const { isTopicNameCutFromSource } = await import('../../../apps/desktop/src/components/chat/topicAnchorModels')
  const source = message({ id: 'ref-source', content_type: 'text', content: '@[Claude 17](aid:11111111-1111-4111-8111-111111111111) Reply with a task reference and enough text to exceed the title limit.\nSecond line' })
  sourceMessages = [source]
  await mount()
  await act(async () => { await surface!.openTopicFromMessage(source.id) })
  const input = createTopic.mock.calls[0]?.[0]
  expect(input).toMatchObject({ sourceChatId: 'chat-A', sourceMessageId: source.id, name: '@Claude 17 Reply with a task reference a…' })
  expect(isTopicNameCutFromSource(input.name, source.content)).toBe(true)
})

it.each(['system', 'attachment'] as const)('keeps server naming for a %s source', async (content_type) => {
  const source = message({ id: 'non-text-source', content_type, content: 'Non-text payload' })
  sourceMessages = [source]
  await mount()
  await act(async () => { await surface!.openTopicFromMessage(source.id) })
  expect(createTopic).toHaveBeenCalledWith({ sourceChatId: 'chat-A', sourceMessageId: source.id, name: null })
})

it.each([
  ['agent', 'agent-author'], ['human', 'human-author'],
  ['departed', 'former-author'], ['self', 'user-1'],
])('delegates a %s-authored source to the shared topic action without choosing participants', async (kind, author) => {
  const source = message({ id: `source-${kind}`, sender_user_id: author, content: 'Source contract', is_mine: kind === 'self' })
  sourceMessages = [source]
  listTopicsOfChat.mockResolvedValue([topic({ name: 'Projected default' })])
  await mount()
  await act(async () => { await surface!.openTopicFromMessage(source.id) })
  expect(createTopic).toHaveBeenCalledExactlyOnceWith({
    sourceChatId: 'chat-A', sourceMessageId: source.id, name: 'Source contract',
  })
  expect(opened.chatIds).toEqual(['topic-1'])
  expect(onCreateFailed).not.toHaveBeenCalled()
})

it('opens the existing task topic when its card is tapped again without making a second entry', async () => {
  const source = message({ id: 'task-card', content_type: 'card', content: JSON.stringify({
    v: 1, type: 'task', text: 'Check the project', agentUserId: 'agent', agentName: 'Claude',
    sessionId: 'session', projectId: 'project', deviceId: 'mac', machineLabel: 'Mac',
  }) })
  sourceMessages = [source]
  listTopicsOfChat.mockResolvedValue([topic({ source_message_id: source.id })])
  await mount()
  await act(async () => { await surface!.openTopicFromMessage(source.id) })
  expect(createTopic).not.toHaveBeenCalled()
  expect(opened.chatIds).toEqual(['topic-1'])
})
