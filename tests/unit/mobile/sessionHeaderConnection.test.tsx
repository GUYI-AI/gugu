// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'
import { SessionTimelinePage } from '../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

// owner 2026-11-08: 「d22 未连接 · 最后在线 4 分钟前」 while d22 was online. The directory saying a machine is off and
// this page's link not answering are two facts: the first is 「设备离线 · 最后在线 …」, the second only 「连接中」. Both sit in
// the header — ❌ a line / banner under it, ❌ 「未连接」 anywhere.
const scope = vi.hoisted(() => ({ link: 'ok' as 'ok' | 'lost' }))
vi.mock('../../../apps/desktop/src/lib/sessionInputOutboxBridge', () => ({ enqueueSessionInput: vi.fn(), retrySessionInputs: vi.fn(), useQueuedSessionInputs: () => [] }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: emptyAgentWatchTimeline(), phase: 'ready', error: null, link: scope.link, pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord', () => ({ useNativeSessionRecord: () => ({ record: null, error: null, followTail() {}, loadNewer() {}, loadOlder: async () => undefined }) }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/SessionConversation', () => ({ SessionConversation: () => <div data-conversation="" /> }))
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { enabledTabContributions: [] } }))
vi.mock('../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true) })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks(); scope.link = 'ok' })

const session = { conversationId: 'session', projectId: 'project', title: 'Task', runtime: 'codex', agentStatus: 'idle', status: { status: 'idle', detail: null } } as unknown as SessionpageSessionSummary
const lastSeen = new Date(Date.now() - 4 * 60_000).toISOString()
const state = () => harness.container.querySelector('[data-testid="agent-watch-hero"] [data-testid="agent-watch-connection-status"]')
const detail = () => harness.container.querySelector('[data-testid="agent-watch-connection-status-detail"]')

it('directory online, link lost: 「连接中」 in the header without 「最后在线」', async () => {
  scope.link = 'lost'
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: true, last_seen_at: lastSeen })} session={session} onBack={() => undefined} />)
  expect(state()?.getAttribute('data-state')).toBe('connecting')
  expect(detail()).toBeNull()
  expect(harness.container.textContent).not.toContain('未连接')
  expect(harness.container.querySelector('.gg-aw-body [data-testid="agent-watch-connection-status"]')).toBeNull()
})

it('directory offline: 「设备离线 · 最后在线 …」 in the header, nothing under it', async () => {
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: false, last_seen_at: lastSeen })} session={session} onBack={() => undefined} />)
  expect(state()?.getAttribute('data-state')).toBe('device_offline')
  expect(detail()?.textContent).toMatch(/4/)
  expect(harness.container.textContent).not.toContain('未连接')
  expect(harness.container.querySelector('.gg-aw-body [data-testid="agent-watch-connection-status"]')).toBeNull()
})

it('directory offline without a last-seen time: the time is omitted', async () => {
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: false, last_seen_at: '' })} session={session} onBack={() => undefined} />)
  expect(state()?.getAttribute('data-state')).toBe('device_offline')
  expect(detail()).toBeNull()
})

it('link answering: the header keeps the agent status, no connection state', async () => {
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: true })} session={session} onBack={() => undefined} />)
  expect(state()).toBeNull()
})
