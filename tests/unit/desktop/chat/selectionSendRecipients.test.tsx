// @vitest-environment jsdom
import { createElement } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

/**
 * A file selection's Send line names no one, so in a group it goes where the composer's cite goes: to the members, other
 * than the sender, who made the cited file (`citeRecipientIds`). In a direct chat it stays unaddressed.
 */
const { sendMock } = vi.hoisted(() => ({ sendMock: vi.fn(async (_chatId: string, _body: string, _options?: { toUserIds?: string[] }) => undefined) }))
const FILE = '0b6f6c1e-58a4-4a39-9a37-3f1f4c7a2d10'
vi.mock('@/lib/supabase', () => ({
  chatDb: {
    rpc: (fn: string) => fn === 'workspace_get_as'
      ? { select: () => ({ single: async () => ({ data: { created_by: 'agent', updated_by: 'me' }, error: null }) }) }
      : Promise.resolve({ data: [{ made_by: 'left-the-group' }], error: null }),
  },
}))
vi.mock('@/store/chatContext', () => ({
  useChatStore: () => ({
    sendMessageToChat: sendMock,
    chats: [{ id: 'group', kind: 'group', member_user_ids: ['me', 'agent', 'bystander'] }, { id: 'dm', kind: 'direct', peer_user_id: 'agent' }],
  }),
}))
vi.mock('@/lib/sessionPublication', async (original) => ({ ...(await original<object>()), getRendererSession: () => ({ user: { id: 'me' } }) }))
const { useSendSelection } = await import('../../../../apps/desktop/src/session/renderer/lib/editor/cite-into-conversation')

let send: ReturnType<typeof useSendSelection>
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  sendMock.mockClear()
  harness = createReactHarness()
  await harness.render(createElement(() => { send = useSendSelection(); return null }))
})
afterEach(() => harness.cleanup())

const cite = { draft: `@[Tracker.md (Line 8)](gugu-file://${FILE}?v=1#lines=8)`, quote: '', refs: [] } as unknown as Parameters<typeof send>[1]

it('a group: the cite and the words go to the members who made the file, not the sender, not someone who left', async () => {
  await send({ kind: 'chat', chatId: 'group' }, cite, 'please check')
  expect(sendMock.mock.calls).toEqual([['group', `${cite.draft}\n\nplease check`, { toUserIds: ['agent'] }]])
})

it('a direct chat: unaddressed, as the composer leaves it', async () => {
  await send({ kind: 'chat', chatId: 'dm' }, cite, '')
  expect(sendMock.mock.calls).toEqual([['dm', cite.draft, { toUserIds: [] }]])
})
