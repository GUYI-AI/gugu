// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useGroupTopics } from '../../../../apps/desktop/src/components/chat/useGroupTopics'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

let harness: ReturnType<typeof createReactHarness> | null = null
afterEach(() => { harness?.cleanup(); harness = null })

it("orders the header topics by activity even when the sidebar pins an older topic", async () => {
  const chats = [
    chat({ id: 'g', kind: 'group', name: 'Group' }),
    chat({ id: 'old', kind: 'topic', source_chat_id: 'g', name: 'old', last_message_at: '2026-11-01T00:00:00Z', is_pinned: true }),
    chat({ id: 'new', kind: 'topic', source_chat_id: 'g', name: 'new', last_message_at: '2026-11-20T00:00:00Z' }),
  ]
  let topics: ReturnType<typeof useGroupTopics> | null = null
  function Probe() { topics = useGroupTopics('g'); return null }
  harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(Probe, {}), { chat: { chats } })
  expect(topics!.map((topic) => topic.id)).toEqual(['new', 'old'])
})
