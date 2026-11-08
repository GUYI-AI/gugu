// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { projectMessagePreview, type MessagePreviewPayload } from '@gugu/session-core/session-record/message-preview'
import { createReactHarness } from '../../../support/testHarness'
import { foldedPreviewTurn } from '../../../support/foldedPreviewFixture'
import { activityPreviewSources } from '@gugu/session-chat-ui/activity-preview'

const fixture = vi.hoisted(() => ({ preview: null as MessagePreviewPayload | null }))
vi.mock('../../../../apps/desktop/src/hooks/useAgentMessagePreview', () => ({ useAgentMessagePreview: () => ({ status: 'live', preview: fixture.preview }) }))
vi.mock('../../../../apps/desktop/src/hooks/useShownAgentName', () => ({ useShownAgentName: (value: { name: string } | Array<{ name: string }>) => Array.isArray(value) ? value.map(row => row.name) : value.name }))
vi.mock('../../../../apps/desktop/src/components/Avatar', () => ({ Avatar: () => <span>Worker</span> }))
vi.mock('../../../../apps/desktop/src/store/chatContext', async original => ({ ...await original<object>(), useChatStore: () => ({ messages: [{ id: '6417511d-8f36-4cbc-8cbb-81ce9f97df72', sender_user_id: '11111111-1111-4111-8111-111111111111', content: 'someone@example.com', retracted_at: null }], threadMessages: [], identitiesById: {} }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/actor-identity', () => ({ chatActor: (id: string) => ({ id, name: id.startsWith('user:111') ? 'Worker' : 'Owner', type: id.startsWith('user:111') ? 'agent' : 'human' }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/chat-name', () => ({ chatDisplayName: () => 'Test group' }))
vi.mock('../../../../apps/desktop/src/lib/chatSummariesBridge', () => ({ useChatSummaries: () => new Map([['group', { kind: 'group' }]]), readChatSummary: () => ({ kind: 'group' }), resolveChatId: (id: string) => id }))
const { MessagePreviewCard } = await import('../../../../apps/desktop/src/components/MessagePreviewCard')
let h: ReturnType<typeof createReactHarness>
beforeEach(() => { h = createReactHarness() })
afterEach(() => h.cleanup())

const render = async (kind: 'received' | 'group' | 'owner', version = true) => {
  const projection = projectMessagePreview([foldedPreviewTurn(kind)], activityPreviewSources)
  fixture.preview = { ...projection, chatId: 'group', agentId: 'agent', rev: 1, epoch: 'fixture', at: 1,
    ...(version ? {} : { activityVersion: undefined }),
  }
  await h.render(<MessagePreviewCard chatId="group" token={{ id: 'agent', name: 'Worker', avatarUrl: null, avatarSeed: 'worker', stateKey: 'running', toolCount: 1, lastActiveAt: null }} displayName="Worker" open />)
}
it.each(['received', 'group'] as const)('has no folded body in preview text, titles or accessibility attributes for %s activity', async activity => {
  await render(activity)
  expect(h.container.textContent).not.toContain('someone@example.com')
  expect(h.container.innerHTML).not.toContain('someone@example.com')
  expect(h.container.textContent).toMatch(/Worker|Test group/)
})
it('keeps owner dialogue visible when its source is explicitly outside a fold', async () => {
  await render('owner')
  expect(h.container.textContent).toContain('Process someone@example.com')
})
it('does not treat an old unclassified preview payload as proven visible owner dialogue', async () => {
  await render('owner', false)
  expect(h.container.innerHTML).not.toContain('someone@example.com')
})
