// @vitest-environment jsdom
// The running preview card's prompts are read by id; a deletion in the account reads again only the prompt of this card
// that was deleted (❌ every prompt of the card for any message deleted anywhere).
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness } from '../../../support/testHarness'

const bus = vi.hoisted(() => ({ deleted: null as null | ((operations: unknown[]) => void) }))
const reads = vi.hoisted(() => vi.fn(async (id: string) => ({ id, chat_id: 'group', sender_user_id: 'owner', content: `prompt ${id}`, retracted_at: null })))
vi.mock('../../../../apps/desktop/src/lib/chat', async (original) => ({
  ...await original<object>(),
  chatService: { getMessageById: (id: string) => reads(id) },
}))
const prompt = (id: string) => ({ kind: 'prompt', id: `p-${id}`, messageId: `msg:${id}`, activityVersion: 1, activity: null })
vi.mock('../../../../apps/desktop/src/hooks/useAgentMessagePreview', () => ({ useAgentMessagePreview: () => ({ status: 'live', preview: {
  activityVersion: 1, chatId: 'group', agentId: 'agent', rev: 1, epoch: 'e', at: 1, running: true, now: null, ended: null,
  entries: [prompt('m-a'), prompt('m-b')],
} }) }))
vi.mock('../../../../apps/desktop/src/hooks/useShownAgentName', () => ({ useShownAgentName: (value: { name: string } | Array<{ name: string }>) => Array.isArray(value) ? value.map(row => row.name) : value.name }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => null }))
vi.mock('../../../../apps/desktop/src/store/chatContext', async original => ({ ...await original<object>(), useChatStore: () => ({
  messages: [], threadMessages: [], identitiesById: {},
  subscribeAccountRevision: (_event: string, listener: (operations: unknown[]) => void) => { bus.deleted = listener; return () => undefined },
}) }))
vi.mock('../../../../apps/desktop/src/lib/chatSummariesBridge', () => ({ subscribeChatNames: () => () => undefined, chatNamesVersion: () => 0, useChatSummaries: () => new Map([['group', { kind: 'group' }]]), readChatSummary: () => ({ kind: 'group' }), resolveChatId: (id: string) => id }))
const { MessagePreviewCard } = await import('../../../../apps/desktop/src/components/MessagePreviewCard')
const { followRendererSession, queryClient } = await import('../../../../apps/desktop/src/lib/replica')
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness(); queryClient.clear(); followRendererSession('SIGNED_IN', 'me'); reads.mockClear() })
afterEach(() => h.cleanup())

it('a deletion reads again only this card\'s prompt that was deleted', async () => {
  await h.render(<MessagePreviewCard chatId="group" token={{ id: 'agent', name: 'Worker', avatarUrl: null, avatarSeed: 'worker', stateKey: 'running', toolCount: 1, lastActiveAt: null }} displayName="Worker" open />)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(reads.mock.calls.map(([id]) => id).sort()).toEqual(['m-a', 'm-b'])
  reads.mockClear()
  await act(async () => { bus.deleted!([{ revision: '9', event: 'message_deleted', payload: { chat_id: 'other', entity_id: 'elsewhere' } }]) })
  await act(async () => { bus.deleted!([{ revision: '10', event: 'message_deleted', payload: { chat_id: 'group', entity_id: 'm-a' } }]) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(reads.mock.calls.map(([id]) => id)).toEqual(['m-a'])
})

it('a prompt read before whose read again fails stays drawn and says the failure (❌ drawn as current)', async () => {
  await h.render(<MessagePreviewCard chatId="group" token={{ id: 'agent', name: 'Worker', avatarUrl: null, avatarSeed: 'worker', stateKey: 'running', toolCount: 1, lastActiveAt: null }} displayName="Worker" open />)
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(h.container.querySelectorAll('[data-refresh-failed]')).toHaveLength(0)
  reads.mockImplementationOnce(async () => { throw new Error('offline') })
  await act(async () => { bus.deleted!([{ revision: '11', event: 'message_deleted', payload: { chat_id: 'group', entity_id: 'm-a' } }]) })
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
  expect(h.container.querySelectorAll('[data-refresh-failed]')).toHaveLength(1)
  expect(h.container.textContent).toContain('prompt m-a')
})
