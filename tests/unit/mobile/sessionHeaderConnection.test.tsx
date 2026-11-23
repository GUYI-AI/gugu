// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createReactHarness, device, renderWithAppProviders } from '../../support/testHarness'
import { SessionTimelinePage } from '../../../apps/desktop/src/components/session-watch/SessionTimelinePage'
import { emptyAgentWatchTimeline } from '../../../apps/desktop/src/components/session-watch/agent-watch-store'
import type { SessionpageSessionSummary } from '@gugu/session-core/session-record/contract'

// owner 2026-11-08: 「d22 未连接 · 最后在线 4 分钟前」 while d22 was online. The directory saying a machine is off and
// this page's link not answering are two facts: the first is 「设备离线 · 最后在线 …」, the second only 「连接中」. Both sit in
// the header — ❌ a line / banner under it, ❌ 「未连接」 anywhere.
const scope = vi.hoisted(() => ({ link: 'ok' as 'ok' | 'lost' | 'connecting', phase: 'ready' as 'ready' | 'loading' }))
vi.mock('../../../apps/desktop/src/lib/outbox/kinds/sessionInput', () => ({ enqueueSessionInput: vi.fn(), retrySessionInputs: vi.fn(), useQueuedSessionInputs: () => [] }))
vi.mock('../../../apps/desktop/src/components/session-watch/useAgentWatchSession', () => ({ useAgentWatchSession: () => ({ timeline: emptyAgentWatchTimeline(), phase: scope.phase, error: null, link: scope.link, pendingSends: [], reload() {}, loadOlder: async () => undefined, cancel() {}, respond() {} }) }))
vi.mock('../../../apps/desktop/src/components/session-watch/SessionConversation', () => ({ SessionConversation: ({ emptyNote }: { emptyNote?: unknown }) => <div data-conversation="">{emptyNote as never}</div> }))
vi.mock('../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions', async (importOriginal) => ({ ...await importOriginal<object>(), useInstalledApps: () => ({ state: 'value', value: { enabledTabContributions: [] }, stale: false, error: null }) }))
vi.mock('../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true) })
afterEach(() => { harness.cleanup(); vi.restoreAllMocks(); scope.link = 'ok'; scope.phase = 'ready' })

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

// owner msg 0a4871f7: a task on a machine that stopped answering opened as an endless skeleton under 「连接中」, the page
// itself claiming the machine online. The desktop had already found it not answering (the gate's offline view): until this
// page's own link answers, it says so — in the header and where the conversation would be — ❌ a skeleton.
const skeleton = () => harness.container.querySelector('[data-testid="acp-chat-history-loading"]')
const unreachable = () => harness.container.querySelector('[data-testid="agent-watch-unreachable"]')

it('desktop found the machine not answering, first read pending: 「连接中」 and the reason in place, no skeleton', async () => {
  scope.link = 'connecting'
  scope.phase = 'loading'
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: true })} session={session} unreachable="juma4 did not respond. Check that it is online and retry." onBack={() => undefined} />)
  expect(state()?.getAttribute('data-state')).toBe('connecting')
  expect(skeleton()).toBeNull()
  expect(unreachable()?.textContent).toContain('juma4 did not respond')
  expect(unreachable()?.querySelector('button')).not.toBeNull()
})

it('nothing known against the machine, first read pending: the reading skeleton, no connection state', async () => {
  scope.link = 'connecting'
  scope.phase = 'loading'
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: true })} session={session} onBack={() => undefined} />)
  expect(state()).toBeNull()
  expect(skeleton()).not.toBeNull()
  expect(unreachable()).toBeNull()
})

it('desktop found it not answering but this page\'s link answered: the conversation, no failure', async () => {
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: true })} session={session} unreachable="juma4 did not respond." onBack={() => undefined} />)
  expect(state()).toBeNull()
  expect(unreachable()).toBeNull()
})

it('directory offline: the machine named in place, nothing to retry (it comes back by itself)', async () => {
  await renderWithAppProviders(harness, <SessionTimelinePage device={device('d22', [], { is_online: false, last_seen_at: lastSeen })} session={session} onBack={() => undefined} />)
  expect(unreachable()).not.toBeNull()
  expect(unreachable()?.querySelector('button')).toBeNull()
})
