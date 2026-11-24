// @vitest-environment jsdom
// #2797 moves phone group topic navigation above the composer; desktop pinned tabs remain.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { queryClient } from '../../../../apps/desktop/src/lib/replica'
import { captureOpenedChats } from '../../../support/openedChats'

const { getImRepositoryMock, TOPICS, pinPrefs } = vi.hoisted(() => ({
  getImRepositoryMock: vi.fn(),
  pinPrefs: { ids: ['t1'] },
  TOPICS: [
    { chat_id: 't1', name: '把登录页的报错改成中文并补上测试', source_message_id: 'm1', creator_user_id: 'user-1', last_message_at: null, message_count: 3, participant_count: 2, is_participant: true },
    { chat_id: 't2', name: '周报', source_message_id: 'm2', creator_user_id: 'user-1', last_message_at: null, message_count: 1, participant_count: 2, is_participant: true },
  ],
}))

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))
vi.mock('../../../../apps/desktop/src/lib/chatPinSettings', () => ({
  readChatPinSettings: vi.fn(async () => ({ topicIds: [...pinPrefs.ids] })),
  setChatPinPreference: vi.fn(),
  watchChatPinSettings: () => () => {},
}))
// A closing panel retained for its exit animation must not count as an open panel.
vi.mock('framer-motion', async (importOriginal) => ({
  ...await importOriginal<typeof import('framer-motion')>(),
  AnimatePresence: ({ children }: { children: ReactNode }) => children,
}))
vi.mock('../../../../apps/desktop/src/lib/topics', () => ({
  topicService: {
    createTopic: vi.fn(),
    listTopicsOfChat: vi.fn(async (chatId: string) => (chatId === 'g1' ? TOPICS : [])),
    getAgentFloodAdjustment: vi.fn(async () => null),
    undoAgentFloodAdjustment: vi.fn(async () => 0),
  },
}))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({
  chatService: {
    getChatFiles: vi.fn(async () => []),
    getMessages: vi.fn(async () => []),
    getGroupCollab: vi.fn(async () => ({
      snapshot: {
        scheduler: { chat_id: 'g1', paused: false, queue_count: 0, blocked_count: 0, summary: null, updated_at: '2026-09-29T00:00:00.000Z' },
        humans: [], agents: [], tasks: [],
      },
      identities: [],
    })),
    getOtherMembersReadSeqs: vi.fn(async () => ({})),
    getThreadMessages: vi.fn(async () => []),
    // The chat surface reads the viewer's authority from the server projection (group_info_as).
    getGroupChatSettings: vi.fn(async () => ({ id: 'g1', my_role: 'member', can_manage: false, can_dissolve: false, can_archive_topic: false, allow_member_invite: false })),
  },
}))

let harness: ReturnType<typeof createReactHarness>
let repository: AccountImRepository
let opened: ReturnType<typeof captureOpenedChats>

beforeEach(async () => {
  pinPrefs.ids = ['t1']
  queryClient.clear()
  harness = createReactHarness()
  opened = captureOpenedChats()
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
})

afterEach(() => {
  repository.close()
  harness.cleanup()
  opened.stop()
  queryClient.clear()
})

let topicRows: Record<string, Partial<ReturnType<typeof chat>>> = {}
async function render(chatId: string, mobile = true, kind: 'group' | 'dm' | 'topic' = 'group') {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', mobile, hidden: false, openNonce: 0 }), {
    chat: {
      getImRepository: getImRepositoryMock,
      activeChatId: chatId,
      activeChat: chat({ id: chatId, kind, name: '登录改版', ...(kind === 'topic' ? { source_chat_id: 'g1' } : {}) }),
      chats: TOPICS.map((topic) => chat({ id: topic.chat_id, kind: 'topic', source_chat_id: 'g1', name: topic.name, ...topicRows[topic.chat_id] })),
    },
  })
  await act(async () => { await Promise.resolve() })
}

const q = (selector: string) => [...harness.container.querySelectorAll<HTMLElement>(selector)].find(node => !node.closest('[data-testid=session-chat-panel].invisible')) ?? null
const tab = (id: string) => q(`[data-testid="phone-chat-tab-${id}"]`)

const choice = (id: string) => document.querySelector<HTMLElement>(`[data-testid="phone-room-topic"][data-topic-id="${id}"]`)
const mainChoice = () => document.querySelector<HTMLElement>('[data-testid="phone-room-main"]')
async function openTopics() {
  await vi.waitFor(() => expect(q('[data-testid="phone-room-topics"]')).not.toBeNull())
  await act(async () => { q('[data-testid="phone-room-topics"]')!.click() })
  await vi.waitFor(() => expect(mainChoice()).not.toBeNull())
}
async function pickTopic(id: string | null) {
  await openTopics()
  await act(async () => { (id ? choice(id) : mainChoice())!.click() })
  await vi.waitFor(() => expect(document.querySelector('[data-testid="phone-room-controls-sheet"]')).toBeNull())
}

describe('shared group topic navigation (#446, #837, #2797)', () => {
  it('phone: the composer topic sheet contains Group chat and every topic without pinning', async () => {
    pinPrefs.ids = []
    await render('g1')
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
    await openTopics()
    expect(mainChoice()?.getAttribute('aria-checked')).toBe('true')
    expect(choice('t1')?.textContent).toContain(TOPICS[0]!.name)
    expect(choice('t2')).not.toBeNull()
  })

  it('phone: topics calling you precede ordinary unread topics, marked red with the call count; other unread is a grey dot', async () => {
    const locator = (unread: number, addressed: number) => ({ stream_id: 'main', stream_kind: 'main' as const, thread_root_id: null, message_id: 'm', message_seq: 1, unread_count: unread, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false })
    topicRows = { t1: { unread_count: 9, unread_locator: locator(9, 0) }, t2: { unread_count: 27, unread_locator: locator(27, 2) } }
    try {
      await render('g1')
      await openTopics()
      expect(choice('t2')?.querySelector('.gg-chip[data-tone="danger"]')?.textContent).toBe('@2')
      expect(choice('t1')?.querySelector('.gg-chip[data-shape="dot"]')).not.toBeNull()
      expect(choice('t1')?.textContent).not.toContain('9')
      expect([...document.querySelectorAll<HTMLElement>('[data-testid="phone-room-topic"]')].map(node => node.dataset.topicId)).toEqual(['t2', 't1'])
    } finally { topicRows = {} }
  })

  it('picking a topic opens it as the main conversation; inside it, Group chat opens the group', async () => {
    await render('g1')
    await pickTopic('t1')
    expect(opened.chatIds).toEqual(['t1'])
    harness.cleanup()
    harness = createReactHarness()
    await render('t1', true, 'topic')
    await openTopics()
    expect(choice('t1')?.getAttribute('aria-checked')).toBe('true')
    expect(mainChoice()?.getAttribute('aria-checked')).toBe('false')
    await act(async () => { mainChoice()!.click() })
    expect(opened.chatIds).toEqual(['t1', 'g1'])
  })

  it('a group without topics still has the main conversation and Agent controls', async () => {
    await render('g2')
    expect(q('[data-testid="phone-room-agents"]')).not.toBeNull()
    await openTopics()
    expect(document.querySelectorAll('[data-testid="phone-room-topic"]')).toHaveLength(0)
    expect(mainChoice()?.getAttribute('aria-checked')).toBe('true')
  })

  it('desktop: the pinned strip opens a topic as the main conversation', async () => {
    await render('g1', false)
    await vi.waitFor(() => expect(tab('t1')).not.toBeNull())
    expect(tab('t2')).toBeNull()
    expect(q('[data-testid="phone-room-composer-controls"]')).toBeNull()
    await act(async () => { tab('t1')!.click() })
    expect(opened.chatIds).toEqual(['t1'])
  })

  it('desktop: hides the pinned strip when no topics are pinned', async () => {
    pinPrefs.ids = []
    await render('g1', false)
    await vi.waitFor(() => expect(queryClient.getQueryData(['chatPins', 'user-1', 'g1'])).toEqual({ topicIds: [] }))
    expect(q('[data-testid="phone-chat-tabs"]')).toBeNull()
  })

  it('does not add room navigation to a direct message', async () => {
    await render('g1', true, 'dm')
    expect(q('[data-testid="phone-room-composer-controls"]')).toBeNull()
  })
})
