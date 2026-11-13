// @vitest-environment jsdom
// The session tree's first draw waits for `chatListRestored`: the shell settles it once the stored list was read
// (painted, found empty, or failed), and with painted rows the summaries are already published by then.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, expect, it, vi } from 'vitest'
import { chat } from '../../../support/testHarness'

;(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
const list = { chats: [chat({ id: 'chat-1', kind: 'group', name: 'Launch' })], chatsRead: false, loadingChats: false, chatsLoadFailed: false, identitiesById: {} }
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({ useChatStore: () => list }))
vi.mock('../../../../apps/desktop/src/store/contactsContext', () => ({ useContactsStore: () => ({ contacts: [] }) }))
vi.mock('../../../../apps/desktop/src/hooks/useNativeAgentChats', () => ({ useNativeAgentChats: (chats: unknown) => chats }))
const { ChatSummariesHost } = await import('../../../../apps/desktop/src/components/chat/ChatSummariesHost')
const { chatListRestored, readChatSummaries } = await import('../../../../apps/desktop/src/lib/chatSummariesBridge')

const host = document.createElement('div'), root = createRoot(host)
const draw = (state: Partial<typeof list>) => act(async () => { Object.assign(list, state); root.render(<ChatSummariesHost key={JSON.stringify(state)} />) })
afterEach(() => { delete (window as unknown as Record<string, unknown>).__GUGU_CHAT_LIST_RESTORED__ })

it('stays unsettled while the stored list has not been read, then settles with the painted rows already published', async () => {
  let settled = false
  void chatListRestored().then(() => { settled = true })
  await draw({})
  expect(settled).toBe(false)
  expect(readChatSummaries()).toBeNull()
  await draw({ chatsRead: true })
  expect(settled).toBe(true)
  expect(readChatSummaries()?.get('chat-1')?.name).toBe('Launch')
})

it.each(['loadingChats', 'chatsLoadFailed'] as const)('settles without rows when the stored list is empty or unreadable (%s)', async (state) => {
  let settled = false
  void chatListRestored().then(() => { settled = true })
  await draw({ chatsRead: false, [state]: true })
  expect(settled).toBe(true)
  await draw({ [state]: false })
})
