// @vitest-environment jsdom
// DE-3: the assistant's private chat just made by open_dm is put into the chat list at once and the list read again (as
// every other open_dm caller does), ❌ the shell holding a chat id the chat list does not know.
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { expect, it, vi } from 'vitest'

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const store = vi.hoisted(() => ({ upsertChat: vi.fn(), refreshChats: vi.fn(async () => undefined) }))
vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: { getOrCreateDM: async () => 'dm-new' } }))
vi.mock('../../../../apps/desktop/src/store/chatContext', () => ({
  useChatStore: () => store,
  useChatStoreSelect: () => null,
}))

const { useAssistantDm } = await import('../../../../apps/desktop/src/components/assistant/useAssistantDm')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')

it('puts the new chat into the list once and reads the list again', async () => {
  queryClient.clear()
  followRendererSession('SIGNED_IN', 'owner')
  let chatId: string | null = null
  function Probe() { chatId = useAssistantDm('assistant-1').chatId; return null }
  const root = createRoot(document.createElement('div'))
  await act(async () => root.render(<Probe />))
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  await act(async () => root.render(<Probe />))
  expect(chatId).toBe('dm-new')
  expect(store.upsertChat).toHaveBeenCalledTimes(1)
  expect(store.upsertChat).toHaveBeenCalledWith(expect.objectContaining({ id: 'dm-new' }))
  expect(store.refreshChats).toHaveBeenCalledTimes(1)
  await act(async () => root.unmount())
})
