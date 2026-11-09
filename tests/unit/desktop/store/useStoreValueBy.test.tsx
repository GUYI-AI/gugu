// @vitest-environment jsdom
// A store subscriber reads a value only when its signature changes: the open chat's identity survives activity on it,
// and a header's topics follow the chat it shows.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'
import { useChatTopicPins } from '../../../../apps/desktop/src/components/chat/useChatTopicPins'
import { ChatStoreProvider, useActiveChatIdentity } from '../../../../apps/desktop/src/store/chatContext'
import { chat } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/components/chat/useChatPinSettings', () => ({
  useChatPinSettings: () => ({ topicIds: [], set: () => undefined }),
}))
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const store = (fields: object) => fields as never

it('gives the open chat a new identity on a rename, not on unread activity', () => {
  const seen: unknown[] = []
  function Reader() {
    seen.push(useActiveChatIdentity())
    return null
  }
  const open = chat({ id: 'a', name: 'Before' })
  const root = createRoot(document.createElement('div'))
  const draw = (activeChat: unknown) => act(() => root.render(createElement(ChatStoreProvider, { value: store({ activeChat, chats: [] }) }, createElement(Reader))))
  draw(open)
  const first = seen.at(-1)
  draw({ ...open, unread_count: 5, last_message_preview: 'new', last_message_notice: { kind: 'x' } })
  expect(seen.at(-1)).toBe(first)
  const renamed = { ...open, name: 'After' }
  draw(renamed)
  expect(seen.at(-1)).toBe(renamed)
})

it('reads the topics of the chat it now shows, when neither chat had any', () => {
  let topics: unknown[] = []
  let current = 'a'
  function Reader() {
    topics = useChatTopicPins(current).topics
    return null
  }
  const root = createRoot(document.createElement('div'))
  const draw = (chats: unknown[]) => act(() => root.render(createElement(ChatStoreProvider, { value: store({ activeChat: null, chats }) }, createElement(Reader))))
  draw([chat({ id: 'a' }), chat({ id: 'b' })])
  expect(topics).toEqual([])
  current = 'b'
  draw([chat({ id: 'a' }), chat({ id: 'b' })])
  expect(topics).toEqual([])
  draw([chat({ id: 'a' }), chat({ id: 'b' }), chat({ id: 't', kind: 'topic', source_chat_id: 'b' } as never)])
  expect(topics).toHaveLength(1)
})
