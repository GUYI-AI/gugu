// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GroupChatSettings } from '@gugu/core/shared/types/chat'
import { createNode, createReactHarness, renderWithAppProviders } from '../../support/testHarness'

/**
 * A group's settings are one reading (open-flicker; the continuity scan saw group_info_as read three times per open): the
 * chat area, the header commands, the members page and the row menu share one read, and a write shows on all of them.
 */
vi.mock('../../../apps/desktop/src/lib/chat', () => ({
  chatService: { getGroupChatSettings: vi.fn(), updateGroupChatSettings: vi.fn() },
}))
const { chatService } = await import('../../../apps/desktop/src/lib/chat')
const { useGroupChatSettings } = await import('../../../apps/desktop/src/components/chat/useGroupChatSettings')
const getSettings = vi.mocked(chatService.getGroupChatSettings)
const updateSettings = vi.mocked(chatService.updateGroupChatSettings)

const loaded = { id: 'chat-1', name: 'Ops', my_role: 'owner', can_manage: true, group_prompt: 'old' } as unknown as GroupChatSettings
const seen: Record<string, ReturnType<typeof useGroupChatSettings>> = {}
function Surface({ name }: { name: string }) {
  seen[name] = useGroupChatSettings('chat-1')
  return null
}

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness()
  getSettings.mockResolvedValue(loaded)
  updateSettings.mockImplementation(async (_chatId, input) => ({ ...loaded, ...input }) as GroupChatSettings)
})
afterEach(() => { harness.cleanup(); vi.clearAllMocks() })

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })

describe('group settings, one reading per group', () => {
  it('several surfaces of one group open with one read', async () => {
    await renderWithAppProviders(harness, createNode('div', null, createNode(Surface, { name: 'area' }), createNode(Surface, { name: 'commands' }), createNode(Surface, { name: 'members' })))
    await settle()
    expect(getSettings).toHaveBeenCalledTimes(1)
    expect(seen.area?.settings?.group_prompt).toBe('old')
    expect(seen.members?.settings?.group_prompt).toBe('old')
  })

  it('a write on one surface shows on the others', async () => {
    await renderWithAppProviders(harness, createNode('div', null, createNode(Surface, { name: 'area' }), createNode(Surface, { name: 'members' })))
    await settle()
    await act(async () => { await seen.members!.update({ group_prompt: 'new' }) })
    expect(seen.area?.settings?.group_prompt).toBe('new')
  })

  it('is null before it is read, never default settings', async () => {
    getSettings.mockReturnValue(new Promise(() => {}))
    await renderWithAppProviders(harness, createNode(Surface, { name: 'area' }))
    expect(seen.area?.settings).toBeNull()
    expect(seen.area?.error).toBeNull()
  })
})
