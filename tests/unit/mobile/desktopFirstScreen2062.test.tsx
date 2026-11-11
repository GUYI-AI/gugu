// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTimelineSession, type SessionpageTimelineClient } from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import { useSessionHistorySource } from '../../../apps/desktop/src/mobile/agent-watch/use-session-history-source'
import { boundedWindowReady } from '../../../apps/desktop/src/mobile/agent-watch/desktop-window-history'
import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

function createReactHarness() {
  const container = document.createElement('div')
  document.body.append(container)
  const root = createRoot(container)
  return { render: async (node: ReactNode) => { await act(async () => root.render(node)) },
    cleanup: () => { act(() => root.unmount()); container.remove() } }
}
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })

const f = vi.hoisted(() => ({ cached: vi.fn(), hydrate: vi.fn(), rpc: vi.fn(), timelineRead: vi.fn(), timelineHydrate: vi.fn(), timelineWrite: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/timeline-cache', () => ({
  readCachedTimeline: f.timelineRead, hydrateCachedTimeline: f.timelineHydrate, writeCachedTimeline: f.timelineWrite,
  readCachedNativeRecord: f.cached, hydrateCachedNativeRecord: f.hydrate, writeCachedNativeRecord: vi.fn(),
}))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ sessionTimeline: { sessionNativeRecord: f.rpc } }), onLinkChange: () => () => {},
}))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))
vi.mock('@gugu/session-shared', () => ({ isDeepEqual: (a: unknown, b: unknown) => a === b }))
vi.mock('../../../apps/desktop/src/lib/userFacingError', () => ({ messageForUser: String }))

let harness: ReturnType<typeof createReactHarness>
beforeEach(() => { vi.clearAllMocks(); f.cached.mockReturnValue(null); harness = createReactHarness() })
afterEach(() => { harness.cleanup(); vi.useRealTimers() })

// D12: a task opened over the assistant App's panel (AssistantTaskChatWindow → PeekSessionTimeline) showed the raw
// record — `<gugu_delivery>`, `<system-reminder>`, the task context, thinking — because the desktop task page read the
// bounded source window, whose fragments nothing resolves to cleaned turns. It reads the task page archive, as the
// left column does.
it.each([['claude', true], ['codex', true], ['claude', false]])('a desktop task page on a %s record reads the task page archive, not the raw source window (local %s)', async (_format, local) => {
  f.hydrate.mockResolvedValue(null)
  f.rpc.mockResolvedValue({ ok: true, value: { turns: [], originTurnIds: [], activeTurn: null,
    nextCursor: null, latestStoredSeq: 0, hasNewer: false } })
  let shown!: ReturnType<typeof useSessionHistorySource>
  function Probe() {
    shown = useSessionHistorySource({ deviceId: 'this-mac', sessionId: 'task', native: true, online: true, local })
    return null
  }
  await harness.render(<Probe />)
  expect(shown.boundedHistory).toBe(false)
  expect(shown.nativeHistory).toBe(true)
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith({ conversationId: 'task', tail: true })
})

it('a desktop task page without a native record reads the ordinary timeline, not the raw source window', async () => {
  let shown!: ReturnType<typeof useSessionHistorySource>
  function Probe() {
    shown = useSessionHistorySource({ deviceId: 'this-mac', sessionId: 'task', native: false, online: true, local: true })
    return null
  }
  await harness.render(<Probe />)
  expect(shown.boundedHistory).toBe(false)
  expect(shown.nativeHistory).toBe(false)
  expect(f.rpc).not.toHaveBeenCalled()
})

it('does not use nonempty turns or partial metadata as bounded readiness evidence', () => {
  expect(boundedWindowReady({ turns: [{ id: 'old' }] })).toBe(false)
  expect(boundedWindowReady({ sourceLineage: 'source' })).toBe(false)
  expect(boundedWindowReady({ sourceLineage: '', snapshotRevision: 'pin' })).toBe(false)
  expect(boundedWindowReady({ sourceLineage: 'source', snapshotRevision: 'pin', turns: [] })).toBe(true)
})

it('retains the existing native history reader for the mobile path', async () => {
  f.hydrate.mockResolvedValue(null)
  f.rpc.mockResolvedValue({ ok: true, value: { turns: [], originTurnIds: [], activeTurn: null,
    nextCursor: null, latestStoredSeq: 0, hasNewer: false } })
  function Probe() {
    useSessionHistorySource({ deviceId: 'remote', sessionId: 'phone', native: true, online: true, local: false })
    return null
  }
  await harness.render(<Probe />)
  expect(f.rpc).toHaveBeenCalledExactlyOnceWith({ conversationId: 'phone', tail: true })
})

it('boots the actual bounded timeline hook without reading or writing the aggregate legacy cache', async () => {
  vi.useFakeTimers()
  const client = { boundedWindow: true,
    fetchSnapshot: vi.fn(async () => ({ cursor: { epoch: 'e', seq: 1 }, hasOlder: false, settlements: [],
      turns: [{ id: 't', seq: 0, initiator: 'agent', items: [] }], sourceLineage: 'source', snapshotRevision: 'pin' })),
    subscribeSession: vi.fn(async () => ({})), unsubscribeSession: vi.fn(async () => ({})),
    subscribeSessionEvents: () => () => {}, onLinkChange: () => () => {},
  } as unknown as SessionpageTimelineClient
  function Probe() { useTimelineSession(client, 'desktop', 'd', 's', true); return null }
  await harness.render(<Probe />)
  await act(async () => { await vi.advanceTimersByTimeAsync(1_501) })
  expect(client.fetchSnapshot).toHaveBeenCalledOnce()
  expect(client.subscribeSession).toHaveBeenCalledOnce()
  expect(f.timelineRead).not.toHaveBeenCalled()
  expect(f.timelineHydrate).not.toHaveBeenCalled()
  expect(f.timelineWrite).not.toHaveBeenCalled()
})

it('keeps an explicitly locating bounded source loading and retries without a size or elapsed-time skip', async () => {
  vi.useFakeTimers()
  const client = { boundedWindow: true,
    fetchSnapshot: vi.fn(async () => { throw Object.assign(new Error('locating'), { code: 'source_locating' }) }),
    subscribeSessionEvents: () => () => {}, onLinkChange: () => () => {},
    unsubscribeSession: vi.fn(async () => ({})),
  } as unknown as SessionpageTimelineClient
  let shown!: ReturnType<typeof useTimelineSession>
  function Probe() { shown = useTimelineSession(client, 'desktop', 'd', 's', true); return null }
  await harness.render(<Probe />)
  await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
  expect(client.fetchSnapshot).toHaveBeenCalledTimes(31)
  expect(shown.phase).toBe('loading')
  expect(shown.error).toBeNull()
  expect(shown.waitingForRecord).toBe(false)
})
