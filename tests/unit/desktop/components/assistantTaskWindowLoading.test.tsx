// @vitest-environment jsdom
// A task shown in the assistant App's host layer (and in the built-in assistant pane) is the task page
// (SessionTimelinePage, through AssistantTaskChatWindow → PeekSessionTimeline). D12: it drew the bounded source window,
// the provider's raw records — `<gugu_delivery …>`, `<system-reminder>`, `<![CDATA[`, the task context, thinking — as
// fragments nothing resolves to cleaned turns, while the same task opened from the left column was clean. The task layer
// reads the task page archive, the left column's cleaned record, and never the raw window; other desktop task pages keep
// the format routing (#2135). D11: no 「Loading…」 is left.
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionpageSessionSummary, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import { createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'
import { createWindowOpenings } from '../../../../apps/desktop/electron/session/main/core/session-timeline/window-opening'
import { SessionTimelinePage } from '../../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { AssistantTaskChatWindow } from '../../../../apps/desktop/src/components/assistant/AssistantTaskChatWindow'
import { hasPendingWindow } from '../../../../apps/desktop/src/mobile/agent-watch/timeline-window-fields'
import type { AgentWatchTimeline } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'

const bus = vi.hoisted(() => ({
  routes: {} as Record<string, (input: never) => unknown>,
  listeners: new Map<string, Set<(payload: unknown) => void>>(),
}))
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessionTimeline: new Proxy({}, { get: (_, route: string) => (input: never) => Promise.resolve(bus.routes[route]?.(input) ?? { ok: false, error: { code: 'no_route', message: route } }) }) }),
  events: { on: (channel: { name: string }, listener: (payload: unknown) => void, topic: string) => {
    const key = `${channel.name}\n${topic}`
    const set = bus.listeners.get(key) ?? new Set()
    bus.listeners.set(key, set.add(listener))
    return () => { set.delete(listener) }
  } },
}))
vi.mock('../../../../apps/desktop/src/lib/sessionInputOutboxBridge', () => ({ enqueueSessionInput: vi.fn(), retrySessionInputs: vi.fn(), useQueuedSessionInputs: () => [] }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/timeline-cache', () => ({
  readCachedTimeline: () => null, hydrateCachedTimeline: async () => null, writeCachedTimeline: () => {},
  readCachedNativeRecord: () => null, hydrateCachedNativeRecord: async () => null, writeCachedNativeRecord: () => {},
}))
// The conversation is drawn by SessionConversation; what it is handed — the turns, a window's fragments, its
// 「Loading…」 line (hasPendingWindow, SessionConversation.tsx) — is drawn here from the same timeline.
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/SessionConversation', () => ({
  SessionConversation: ({ timeline }: { timeline: AgentWatchTimeline & { sourceFragments?: Array<{ text?: string }> } }) => <div data-testid="conversation" data-turns={timeline.turns.map(turn => turn.id).join()}>
    {timeline.turns.flatMap(turn => turn.items.map(item => 'text' in item ? <p key={item.id}>{String(item.text)}</p> : null))}
    {(timeline.sourceFragments ?? []).map((fragment, index) => <p key={index}>{fragment.text}</p>)}
    {hasPendingWindow(timeline) ? <div role="status" data-testid="loading-window">Loading…</div> : null}
  </div> as ReactNode,
}))
// The task layer finds the session's row as the task tab does; here this computer lists the one task.
const directory = vi.hoisted(() => ({ device: null as unknown, session: null as unknown }))
vi.mock('../../../../apps/desktop/src/store/devicesContext', () => ({ useDevicesStore: () => ({ devices: [directory.device], phones: [] }) }))
vi.mock('../../../../apps/desktop/src/session/shared/remote-sessions/session-directory', async original => ({ ...await original<object>(),
  useLiveDeviceSessions: () => ({}),
  listedSession: () => ({ row: { deviceId: (directory.device as { device_id: string }).device_id, session: directory.session } }) }))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { enabledTabContributions: [] } }))
vi.mock('../../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))

/** What the provider's own record holds for the task's first turn, as the bounded window hands it out. */
const RAW_RECORD = '<gugu_delivery route="session-direct" from="个人助理"><system-reminder>Attribution for git commits</system-reminder><![CDATA[Write a short markdown checklist]]><gugu_task_context># 任务执行约定</gugu_task_context></gugu_delivery>'
const windowSnapshot = (): TimelineSnapshot => ({ cursor: { epoch: 'window', seq: 1 }, turns: [], settlements: [], hasOlder: false,
  sourceLineage: 'lineage', snapshotRevision: 'revision', pendingLongRecords: [],
  sourceFragments: [{ key: 'raw-delivery', sourceRange: { start: 0, end: 900 }, knownRole: 'user', text: RAW_RECORD, ownership: 'unresolved' }] })
const REPLY = 'Checklist created at Files/weekly-report-checklist.md and delivered to the coordinator.'
const archiveTurn = { id: 'archive-turn', seq: 1, initiator: 'agent' as const, outcome: { kind: 'done' as const },
  items: [{ id: 'reply', kind: 'message' as const, role: 'assistant' as const, text: REPLY }] }

/** The host side of one stopped session on this computer: its raw source window, its task page archive, its timeline. */
function host() {
  const calls: string[] = []
  const openings = createWindowOpenings({
    reserve: () => ({ prepare: async () => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence: 0 }), close() {}, authorize() {} }) as never,
    capture: async () => () => true,
    register: () => () => {},
  })
  const asResult = async (run: () => unknown) => { try { return { ok: true, value: await run() } } catch (error) { return { ok: false, error: { code: (error as { code?: string }).code ?? 'failed', message: (error as Error).message } } } }
  bus.routes = {
    sessionWindowSnapshot: () => { calls.push('window.snapshot'); return { ok: true, value: windowSnapshot() } },
    sessionWindowPrepare: (input: { conversationId: string; subscriptionId: string }) => { calls.push('window.prepare'); return asResult(() => openings.prepare(input)) },
    sessionWindowSubscribe: (input: { conversationId: string; subscriptionId: string }) => {
      calls.push('window.subscribe')
      return asResult(async () => { openings.take(input); return { subscriptionId: input.subscriptionId } })
    },
    sessionNativeRecord: () => {
      calls.push('archive.read')
      return { ok: true, value: { turns: [archiveTurn], originTurnIds: ['archive-turn'], activeTurn: null, nextCursor: null, latestStoredSeq: 1, hasNewer: false } }
    },
    sessionSnapshot: () => { calls.push('timeline.snapshot'); return { ok: true, value: { cursor: { epoch: 'timeline', seq: 1 }, turns: [], settlements: [], hasOlder: false } } },
    sessionSubscribe: (input: { subscriptionId: string }) => { calls.push('timeline.subscribe'); return { ok: true, value: { subscriptionId: input.subscriptionId } } },
    sessionUnsubscribe: () => ({ ok: true, value: undefined }),
  }
  return { calls }
}

const session = { conversationId: 'task-session', projectId: 'project', title: 'Weekly report checklist', harness: 'claude', runtime: 'acp', nativeInputVersion: 1,
  agentStatus: 'idle', status: { status: 'idle', detail: null } } as unknown as SessionpageSessionSummary
const thisComputer = device('this-computer', [], { is_online: true, is_current_device: true })
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => {
  harness = createReactHarness(); bus.listeners.clear(); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true)
  directory.device = thisComputer; directory.session = session
})
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })

/** The assistant/App task layer, as the App panel and the built-in assistant pane open a task. */
const openTask = () => renderWithAppProviders(harness, <AssistantTaskChatWindow agent={{ id: 'task-agent', display_name: 'Weekly report checklist', avatar: null }}
  task={{ sessionId: session.conversationId, deviceId: thisComputer.device_id }} onClose={() => undefined} />)
/** Any other desktop task page on the same session. */
const openOtherTaskPage = () => renderWithAppProviders(harness, <SessionTimelinePage device={thisComputer} session={session} local onBack={() => undefined} />)
const conversation = () => harness.container.querySelector('[data-testid="conversation"]')
const loadingLine = () => harness.container.querySelector('[data-testid="loading-window"]')
/** Waits for what the host has been asked, then for its answers to be drawn. */
const settle = async (until: () => boolean) => {
  const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  for (let i = 0; i < 60 && !until(); i += 1) await tick()
  for (let i = 0; i < 5; i += 1) await tick()
}

it('a task shown over the App panel is drawn from the task page archive, never from the raw source record', async () => {
  const side = host()
  await openTask()
  await settle(() => conversation()?.getAttribute('data-turns') === 'archive-turn')
  expect(conversation()?.getAttribute('data-turns')).toBe('archive-turn')
  expect(conversation()?.textContent).toContain(REPLY)
  for (const raw of ['<gugu_delivery', '<system-reminder>', '<![CDATA[', '<gugu_task_context>', '任务执行约定'])
    expect(conversation()?.textContent).not.toContain(raw)
  expect(side.calls.filter(call => call.startsWith('window.'))).toEqual([])
  expect(side.calls).toContain('archive.read')
  expect(loadingLine()).toBeNull()
})

it('another desktop task page keeps the format routing to the bounded source window', async () => {
  const side = host()
  await openOtherTaskPage()
  await settle(() => side.calls.includes('window.snapshot'))
  expect(side.calls).toContain('window.snapshot')
  expect(side.calls).not.toContain('archive.read')
})
