// @vitest-environment jsdom
// Callers cache the text per row, so the function must change when what it reads about a chat arrives or changes.
import { act, createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it } from 'vitest'
import { useActivityPreviewText } from '../../../../apps/desktop/src/hooks/useActivityPreviewText'
import { publishChatSummaries } from '../../../../apps/desktop/src/lib/chatSummariesBridge'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const group = (name: string, preview = 'a') => ({ id: 'group', kind: 'group', name, unread_count: 0, last_message_preview: preview }) as never
const source = { kind: 'sent', id: 'reply', addresses: { target: { kind: 'chat', conversationId: 'group', whisper: false, threadRootId: null }, recipients: [], confirmed: true, chatKind: 'group', replyTo: null } } as never

it('draws the label again when the group arrives and when it is renamed, not when a message lands', () => {
  let text: ReturnType<typeof useActivityPreviewText> | undefined
  function Reader() {
    text = useActivityPreviewText()
    return null
  }
  act(() => createRoot(document.createElement('div')).render(createElement(Reader)))
  const before = text
  act(() => publishChatSummaries([group('Design')]))
  expect(text).not.toBe(before)
  const arrived = text
  expect(text!(source)).toContain('Design')

  act(() => publishChatSummaries([group('Design', 'a new line')]))
  expect(text).toBe(arrived)

  act(() => publishChatSummaries([group('Research', 'a new line')]))
  expect(text!(source)).toContain('Research')
})
