// @vitest-environment jsdom
import { expect, it, vi } from 'vitest'
import type { GroupChatSettings } from '@gugu/core/shared/types/chat'

/**
 * Account scan (writes after an await): a group settings write that answers after the account changed lands in the account
 * that wrote, ❌ in the next one — B never sees A's group prompt for a chat B has not read.
 */
vi.mock('../../../apps/desktop/src/lib/chat', () => ({ chatService: { getGroupChatSettings: vi.fn(), updateGroupChatSettings: vi.fn() } }))
const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { groupSettings, writeGroupSettings } = await import('../../../apps/desktop/src/components/chat/useGroupChatSettings')
const { followRendererSession } = await import('../../../apps/desktop/src/lib/replica')

it("a write answering after A signed out and B signed in does not put A's settings in B's cache", async () => {
  const loaded = { id: 'chat-1', name: 'Ops', group_prompt: 'old' } as unknown as GroupChatSettings
  vi.mocked(chatService.getGroupChatSettings).mockResolvedValue(loaded)
  let answer!: (value: GroupChatSettings) => void
  vi.mocked(chatService.updateGroupChatSettings).mockReturnValue(new Promise((resolve) => { answer = resolve }))
  followRendererSession('SIGNED_IN', 'owner-a')
  await groupSettings.prefetch('chat-1')
  const writing = writeGroupSettings('chat-1', { group_prompt: "A's prompt" })
  followRendererSession('SIGNED_OUT', null)
  followRendererSession('SIGNED_IN', 'owner-b')
  answer({ ...loaded, group_prompt: "A's prompt" })
  await writing
  expect(groupSettings.peek('chat-1')).toEqual({ state: 'unknown' })
})
