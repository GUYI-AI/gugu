// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest'
import type { ChatItem } from '@gugu/core/shared/types/chat'
import { projectMessagePreview } from '@gugu/session-core/session-record/message-preview'
import { activityPreviewSources } from '@gugu/session-chat-ui/activity-preview'
import { foldedPreviewTurn } from '../../../support/foldedPreviewFixture'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'
import { chat, createReactHarness, device } from '../../../support/testHarness'
import { useNativeAgentChats } from '../../../../apps/desktop/src/hooks/useNativeAgentChats'
import { installOwnedAgentEntry } from '../../../../apps/desktop/src/lib/ownedAgentConversation'
import { publishDirectoryDevices, removeDeviceSessions, updateDeviceSessions } from '../../../../apps/desktop/src/session/shared/remote-sessions/session-directory'
vi.mock('../../../../apps/desktop/src/hooks/useMobileShell', () => ({ useMobileShell: () => true }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/actor-identity', () => ({ chatActor: (id: string) => ({ id, name: 'Worker', type: id.startsWith('user:111') ? 'agent' : 'human' }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/chat/chat-name', () => ({ chatDisplayName: () => 'Test group' }))
vi.mock('../../../../apps/desktop/src/lib/chatSummariesBridge', () => ({ subscribeChatNames: () => () => undefined, chatNamesVersion: () => 0, useChatSummaries: () => new Map([['group', { kind: 'group' }]]), readChatSummary: () => ({ kind: 'group' }), resolveChatId: (id: string) => id }))
let h: ReturnType<typeof createReactHarness> | undefined
let release: (() => void) | undefined
afterEach(() => { h?.cleanup(); release?.(); publishDirectoryDevices([]); removeDeviceSessions('host') })
async function render(kind: 'agent' | 'group' | 'owner', version = true) {
  const projection = projectMessagePreview([foldedPreviewTurn(kind)], activityPreviewSources)
  const entry = projection.entries.find(entry => entry.kind === 'text')!
  if (entry.kind !== 'text') throw new Error('Expected narration')
  const summary: SessionpageSessionSummary = { conversationId: 's', projectId: 'p', title: 'Worker', harness: 'codex', runtime: 'acp', agentStatus: 'idle', lastInteractedAt: '2026-11-08T10:00:00Z', supported: true, agent: { userId: 'agent' },
    nativeLastMessage: { text: 'Process someone@example.com', at: '2026-11-08T10:00:00Z', ...(version ? { activityVersion: 1, activity: entry.activity } : {}) },
  }
  release = installOwnedAgentEntry({ owns: () => true, open: () => true })
  publishDirectoryDevices([device('host', [])])
  updateDeviceSessions('host', { sessions: [summary], cached: false, loading: false })
  h = createReactHarness()
  const rows = [chat({ id: 'c', kind: 'dm', peer_user_id: 'agent', last_message_preview: 'Owner dialogue' })]
  function Fixture() { const result: ChatItem[] = useNativeAgentChats(rows); return <span>{result[0]?.last_message_preview}</span> }
  await h.render(<Fixture />)
  return h.container
}
it.each(['agent', 'group'] as const)('uses a body-free summary for a %s native activity in the phone chat list', async activity => {
  const node = await render(activity)
  expect(node.innerHTML).not.toContain('someone@example.com')
  expect(node.textContent).toMatch(/Worker|Test group/)
})
it('keeps an explicitly personal owner reply unchanged', async () => {
  expect((await render('owner')).textContent).toContain('Process someone@example.com')
})
it('does not expose a legacy native preview without fold provenance', async () => {
  expect((await render('owner', false)).innerHTML).not.toContain('someone@example.com')
})
