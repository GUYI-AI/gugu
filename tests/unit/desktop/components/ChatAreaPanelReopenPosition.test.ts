// @vitest-environment jsdom
// A8 (fe-continuity): on the phone, going back to the list and into the same conversation again is an opening like any
// other: it comes back to where the person was reading (the saved anchor), not to the latest (#461's old rule). An opening
// with new unread still lands at the latest (#6530, discardSaved), and the desktop's chat-scoped opening is unchanged.
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { ChatAreaPanel } from '../../../../apps/desktop/src/components/ChatAreaPanel'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'
import { openImRepository, type AccountImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { queryClient } from '../../../../apps/desktop/src/session/renderer/lib/query-client'

const { getImRepositoryMock, TOPICS, pinPrefs, openings } = vi.hoisted(() => ({
  getImRepositoryMock: vi.fn(),
  pinPrefs: { ids: [] as string[] },
  TOPICS: [] as unknown[],
  openings: [] as Array<{ activationKey: string; discardSaved: boolean | undefined; viewportKey: string }>,
}))
vi.mock('../../../../apps/desktop/src/components/chat/useConversationScrollMemory', async (original) => {
  const actual = await original<typeof import('../../../../apps/desktop/src/components/chat/useConversationScrollMemory')>()
  return {
    ...actual,
    useConversationScrollMemory: (options: Parameters<typeof actual.useConversationScrollMemory>[0]) => {
      openings.push({ activationKey: options.activationKey, discardSaved: options.discardSaved, viewportKey: options.viewportKey })
      return actual.useConversationScrollMemory(options)
    },
  }
})
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
    getSourceState: vi.fn(async () => ({ kind: 'gone' as const })),
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
beforeEach(async () => {
  openings.length = 0
  queryClient.clear()
  harness = createReactHarness()
  repository = await openImRepository('user-1', { adapter: createMemoryLocalSyncDb() })
  getImRepositoryMock.mockReset()
  getImRepositoryMock.mockResolvedValue(repository)
})
afterEach(() => { repository.close(); harness.cleanup(); queryClient.clear() })

async function render(openNonce: number | undefined, mobile: boolean) {
  await renderWithAppProviders(harness, createNode(ChatAreaPanel, { activeTab: 'chats', mobile, hidden: false, ...(openNonce === undefined ? {} : { openNonce }) }), {
    chat: { getImRepository: getImRepositoryMock, activeChatId: 'dm-1', activeChat: chat({ id: 'dm-1', kind: 'dm', name: 'Reader' }), chats: [] },
  })
  await act(async () => { await Promise.resolve() })
}
const keys = () => [...new Set(openings.filter(opening => opening.viewportKey === openings[0]!.viewportKey).map(opening => opening.activationKey))]

it('phone: reopening the same conversation is a new opening, so its saved reading position is replayed', async () => {
  await render(0, true)
  await render(1, true)
  expect(keys(), 'one activation per opening; the same key = the saved anchor is never replayed').toHaveLength(2)
  expect(openings.every(opening => !opening.discardSaved), 'no new unread: nothing discards the saved position').toBe(true)
})

it('desktop: re-rendering the same conversation is still one opening', async () => {
  await render(undefined, false)
  await render(undefined, false)
  expect(keys()).toHaveLength(1)
})
