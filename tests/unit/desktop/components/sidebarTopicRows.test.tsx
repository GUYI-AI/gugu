// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatListPanel } from '../../../../apps/desktop/src/components/ChatListPanel'
import { drainTopicSplitRequest } from '../../../../apps/desktop/src/lib/topicSplitRequest'
import { installSessionViewRequestBridge } from '../../../../apps/desktop/src/session/renderer/features/sessions/stores/session-view-requests'
import { chat, clickElement, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

// jsdom has no layout: give the document (the sidebar list's scroller here) a window's height, so the sidebar's
// virtualized conversation lines (@@@sidebar-chat-window) mount the lines that would fit, as on screen.
beforeEach(() => {
  for (const [key, value] of [['offsetHeight', 900], ['offsetWidth', 1024]] as const) Object.defineProperty(document.documentElement, key, { configurable: true, get: () => value })
})
let harness: ReturnType<typeof createReactHarness>
const openChat = vi.fn()
beforeEach(() => {
  harness = createReactHarness()
  openChat.mockReset()
  installSessionViewRequestBridge(window, { openChat })
})
afterEach(() => harness.cleanup())

const source = chat({ id: 'group', kind: 'group', name: 'Planning' })
const topics = Array.from({ length: 5 }, (_, index) => chat({
  id: `topic-${index}`, kind: 'topic', source_chat_id: source.id, name: `Review ${index}`,
  last_message_at: `2099-01-0${5 - index}T00:00:00Z`, unread_count: index === 4 ? 8 : 0,
}))
const rows = () => Array.from(harness.container.querySelectorAll<HTMLElement>('[data-topic-subrow]'))

describe('shared sidebar topic branches', () => {
  it('a group reveals read topics inline and opens the existing source/split path', async () => {
    const node = createNode(ChatListPanel, { placement: 'sidebar' })
    const markMessageVisible = vi.fn()
    const render = (unread: number) => renderWithAppProviders(harness, node, {
      chat: { chats: [source, ...topics.map((topic) => ({ ...topic, unread_count: topic.id === 'topic-4' ? unread : 0 }))], markMessageVisible },
      contacts: {},
    })
    await render(8)
    expect(rows().map((row) => row.dataset.topicSubrow)).toEqual(['topic-0', 'topic-1', 'topic-2', 'topic-4'])
    expect(rows().at(-1)?.textContent).toContain('8')
    await clickElement(harness.container.querySelector('[data-testid="topic-sunk-section"]') as HTMLElement)
    expect(rows().map((row) => row.dataset.topicSubrow)).toEqual(topics.map((topic) => topic.id))
    expect(harness.container.querySelector('[data-testid="history-panel"]')).toBeNull()
    expect(openChat).not.toHaveBeenCalled()
    expect(markMessageVisible).not.toHaveBeenCalled()
    await clickElement(rows().at(-1)!)
    expect(openChat).toHaveBeenCalledWith(source.id, false)
    expect(drainTopicSplitRequest(source.id)).toMatchObject({ chatId: 'topic-4', sourceChatId: source.id })
    await render(0)
    expect(rows()).toHaveLength(5)
    expect(rows().at(-1)?.textContent).not.toContain('8')
  })

})

