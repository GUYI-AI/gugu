// @vitest-environment jsdom
// A task shown in the assistant App's host layer (and in the built-in assistant pane) is the task page
// (SessionTimelinePage) on a bounded window of the session's record. The host keeps such a window's
// subscription only for an opening it prepared first; its first screen is 「Loading…」 until that subscription
// answers. The host here is the real opening registry (window-opening.ts), so a subscriber that skips the
// preparation is refused exactly as in the app.
import { act, type ReactNode } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { SessionpageSessionSummary, TimelineAfterResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import { createReactHarness, device, renderWithAppProviders } from '../../../support/testHarness'
import { createWindowOpenings } from '../../../../apps/desktop/electron/session/main/core/session-timeline/window-opening'
import { SessionTimelinePage } from '../../../../apps/desktop/src/mobile/agent-watch/SessionTimelinePage'
import { hasPendingWindow } from '../../../../apps/desktop/src/mobile/agent-watch/timeline-window-fields'
import type { AgentWatchTimeline } from '../../../../apps/desktop/src/mobile/agent-watch/agent-watch-store'
import { sessionpageSessionTimelineChannel, sessionpageSessionWindowStatusChannel } from '../../../../apps/desktop/src/session/shared/core/session-timeline/sessionTimelineEvents'

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
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/timeline-cache', () => ({ readCachedTimeline: () => null, hydrateCachedTimeline: async () => null, writeCachedTimeline: () => {} }))
// The conversation is drawn by SessionConversation; what its 「Loading…」 line asks (hasPendingWindow, SessionConversation.tsx) is asked here of the same timeline.
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/SessionConversation', () => ({
  SessionConversation: ({ timeline }: { timeline: AgentWatchTimeline }) => <div data-testid="conversation" data-turns={timeline.turns.map(turn => turn.id).join()}>
    {hasPendingWindow(timeline) ? <div role="status" data-testid="loading-window">Loading…</div> : null}
  </div> as ReactNode,
}))
vi.mock('../../../../apps/desktop/src/session/renderer/features/extensions/installed-extensions-store', () => ({ installedExtensionsStore: { enabledTabContributions: [] } }))
vi.mock('../../../../apps/desktop/src/components/ui/sheetStack', async original => ({ ...await original<object>(), useBackLayer() {} }))

const pending = (ticket: string) => ({ kind: 'pending_long_record' as const, ticket, sourceInstance: 'source', pinnedEnd: 6e9, nextScanOffset: 5e9,
  sourceFence: { start: 5e9, end: 6e9, digest: 'fence' } })
const windowSnapshot = (): TimelineSnapshot => ({ cursor: { epoch: 'window', seq: 1 }, turns: [], settlements: [], hasOlder: false,
  sourceLineage: 'lineage', snapshotRevision: 'revision', pendingLongRecords: [pending('long-reply')] })
const liveTurn = { id: 'live-turn', seq: 1, initiator: 'agent' as const, items: [] }

/** The host side of one session: the real opening registry behind the same routes the window client calls. */
function host(state: { stopped: boolean }) {
  const calls: string[] = []
  const windows: string[] = []
  const emit = (channel: { name: string }, topic: string, payload: unknown) => bus.listeners.get(`${channel.name}\n${topic}`)?.forEach(listener => listener(payload))
  const openings = createWindowOpenings({
    reserve: () => ({ prepare: async () => ({ workerEpoch: 'worker', storeEpoch: 'store', sequence: 0 }), close() {}, authorize() {} }) as never,
    capture: async () => state.stopped ? () => true : null,
    register: () => () => {},
  })
  const asResult = async (run: () => unknown) => { try { return { ok: true, value: await run() } } catch (error) { return { ok: false, error: { code: (error as { code?: string }).code ?? 'failed', message: (error as Error).message } } } }
  bus.routes = {
    sessionWindowSnapshot: () => { calls.push('window.snapshot'); return { ok: true, value: windowSnapshot() } },
    sessionWindowPrepare: (input: { conversationId: string; subscriptionId: string }) => { calls.push('window.prepare'); return asResult(() => openings.prepare(input)) },
    sessionWindowSubscribe: (input: { conversationId: string; subscriptionId: string }) => {
      calls.push('window.subscribe')
      return asResult(async () => {
        openings.take(input)
        windows.push(input.subscriptionId)
        // The first push resolves the long record the first screen was waiting for.
        queueMicrotask(() => emit(sessionpageSessionTimelineChannel, input.subscriptionId, { subscriptionId: input.subscriptionId, result: { ok: true,
          batch: { from: 1, cursor: { epoch: 'window', seq: 2 }, turns: [], removedTurnIds: [], settlements: [], pendingLongRecords: [], resolvedPendingTickets: ['long-reply'] } } satisfies { ok: true; batch: unknown } }))
        return { subscriptionId: input.subscriptionId }
      })
    },
    sessionSubscribe: (input: { subscriptionId: string }) => {
      calls.push('legacy.subscribe')
      // The ordinary timeline answers a cursor that is not its own with its whole current record.
      queueMicrotask(() => emit(sessionpageSessionTimelineChannel, input.subscriptionId, { subscriptionId: input.subscriptionId, result: { ok: false, reset: 'epoch_changed',
        snapshot: { cursor: { epoch: 'legacy', seq: 4 }, turns: [liveTurn], settlements: [], hasOlder: false } } satisfies TimelineAfterResult }))
      return { ok: true, value: { subscriptionId: input.subscriptionId } }
    },
    sessionUnsubscribe: () => ({ ok: true, value: undefined }),
  }
  return { calls, windows, emit }
}

const session = { conversationId: 'task-session', projectId: 'project', title: 'Weekly report checklist', harness: 'claude', runtime: 'acp', nativeInputVersion: 1,
  agentStatus: 'idle', status: { status: 'idle', detail: null } } as unknown as SessionpageSessionSummary
let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { harness = createReactHarness(); bus.listeners.clear(); vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true) })
afterEach(() => { harness.cleanup(); vi.unstubAllGlobals() })

const openTask = () => renderWithAppProviders(harness, <SessionTimelinePage device={device('this-computer', [], { is_online: true, is_current_device: true })} session={session} local onBack={() => undefined} />)
const conversation = () => harness.container.querySelector('[data-testid="conversation"]')
const loadingLine = () => harness.container.querySelector('[data-testid="loading-window"]')
/** Waits for what the host has been asked, then for the pushes it answers with to be drawn. */
const settle = async (until: () => boolean) => {
  const tick = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 10)) })
  for (let i = 0; i < 60 && !until(); i += 1) await tick()
  for (let i = 0; i < 5; i += 1) await tick()
}

it('a stopped task shown on the first screen leaves 「Loading…」 once the host has answered its subscription', async () => {
  const side = host({ stopped: true })
  await openTask()
  await settle(() => side.calls.includes('window.subscribe'))
  expect(conversation()).not.toBeNull()
  expect(loadingLine()).toBeNull()
  expect(side.calls).toEqual(['window.snapshot', 'window.prepare', 'window.subscribe'])
})

it('a running task is followed through the ordinary timeline: its record shows and 「Loading…」 goes', async () => {
  const side = host({ stopped: false })
  await openTask()
  await settle(() => side.calls.includes('legacy.subscribe'))
  expect(conversation()?.getAttribute('data-turns')).toBe('live-turn')
  expect(loadingLine()).toBeNull()
  expect(side.calls).toEqual(['window.snapshot', 'window.prepare', 'legacy.subscribe'])
})

it('a stopped task that starts again while shown is opened afresh and follows the running record', async () => {
  const state = { stopped: true }
  const side = host(state)
  await openTask()
  await settle(() => side.windows.length > 0)
  expect(loadingLine()).toBeNull()
  const subscriptionId = side.windows.at(-1)!
  state.stopped = false
  await act(async () => { side.emit(sessionpageSessionWindowStatusChannel, subscriptionId, { conversationId: session.conversationId, subscriptionId, state: 'failed',
    error: { code: 'scope_changed', message: 'The stopped session changed while opening history' } }) })
  await settle(() => side.calls.at(-1) === 'legacy.subscribe')
  expect(conversation()?.getAttribute('data-turns')).toBe('live-turn')
  expect(loadingLine()).toBeNull()
  expect(side.calls.slice(-3)).toEqual(['window.snapshot', 'window.prepare', 'legacy.subscribe'])
})
