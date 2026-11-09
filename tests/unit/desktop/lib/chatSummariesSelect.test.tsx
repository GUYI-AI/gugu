// @vitest-environment jsdom
// A message in one chat replaces the whole summary map. A subscriber that derives one value must not redraw for it.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { publishChatSummaries, useChatSummariesSelect } from '@/lib/chatSummariesBridge'

const chat = (id: string, preview: string, firstUnread: string | null = null) => ({
  id, kind: 'dm', name: id, peer_user_id: `peer-${id}`, unread_count: 0, last_message_preview: preview,
  unread_locator: firstUnread ? { message_id: firstUnread } : null,
}) as never

it('redraws only when the selected value changes', () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  let renders = 0
  let seen: string | null | undefined
  function Reader() {
    renders += 1
    seen = useChatSummariesSelect((chats) => chats.get('mine')?.firstUnreadMessageId)
    return null
  }
  publishChatSummaries([chat('mine', 'a'), chat('other', 'a')])
  const root = createRoot(document.createElement('div'))
  act(() => root.render(createElement(Reader)))
  expect(renders).toBe(1)

  act(() => publishChatSummaries([chat('mine', 'a'), chat('other', 'new line elsewhere')]))
  expect(renders).toBe(1)

  act(() => publishChatSummaries([chat('mine', 'a', 'm1'), chat('other', 'new line elsewhere')]))
  expect(renders).toBe(2)
  expect(seen).toBe('m1')
  act(() => root.unmount())
})
