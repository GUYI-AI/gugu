// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import { useChatTopicPins } from '../../../../apps/desktop/src/components/chat/useChatTopicPins'
import { chat, createNode, createReactHarness, renderWithAppProviders } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/platform', () => import('../../../support/capacitorPlatformTestDouble'))

// One pin (yangchichi msg:d6738d34): the header's topic menu reads and writes the topic conversation's own is_pinned,
// the same flag the inner sidebar's topic rows pin with; there is no per-group pinned-topics setting anymore.
let harness: ReturnType<typeof createReactHarness> | null = null
afterEach(() => { harness?.cleanup(); harness = null })

it("the header's topic pins are the topics' own is_pinned, and pinning writes that flag", async () => {
  const pinChat = vi.fn(async () => {})
  const chats = [
    chat({ id: 'g', kind: 'group', name: 'Group' }),
    chat({ id: 'old', kind: 'topic', source_chat_id: 'g', name: 'old', last_message_at: '2026-11-01T00:00:00Z', is_pinned: true }),
    chat({ id: 'new', kind: 'topic', source_chat_id: 'g', name: 'new', last_message_at: '2026-11-20T00:00:00Z' }),
  ]
  let pins: ReturnType<typeof useChatTopicPins> | null = null
  function Probe() { pins = useChatTopicPins('g'); return null }
  harness = createReactHarness()
  await renderWithAppProviders(harness, createNode(Probe, {}), { chat: { chats, pinChat } })
  expect(pins!.pinned.map((topic) => topic.id)).toEqual(['old'])
  expect(pins!.topics.map((topic) => topic.id), 'pinned first, then by activity (the inner sidebar order)').toEqual(['old', 'new'])
  pins!.set('new', true)
  expect(pinChat).toHaveBeenCalledWith('new', true)
})
