// @vitest-environment jsdom
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useTimelineSession, type SessionpageTimelineClient } from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import type { TimelineAfterResult, TimelineOlderResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'

vi.mock('../../../apps/desktop/src/mobile/agent-watch/timeline-cache', () => ({
  readCachedTimeline: () => null, hydrateCachedTimeline: async () => null, writeCachedTimeline: () => {},
}))
vi.mock('../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ info: vi.fn(), warn: vi.fn() }) }))
vi.mock('../../../apps/desktop/src/lib/userFacingError', () => ({ messageForUser: String }))
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const turn = (id: string) => ({ id, seq: 0, initiator: 'agent' as const, items: [] })
const snapshot = (): TimelineSnapshot => ({ cursor: { epoch: 'e', seq: 2 },
  turns: [turn('current')], settlements: [], hasOlder: true })
let shown!: ReturnType<typeof useTimelineSession>
let push: (result: TimelineAfterResult) => void
let host: HTMLElement
let root: ReturnType<typeof createRoot>
beforeEach(() => { host = document.createElement('div'); document.body.append(host); root = createRoot(host) })
afterEach(() => { act(() => root.unmount()); host.remove() })
function Probe(props: { client: SessionpageTimelineClient; device?: string; session?: string; enabled?: boolean }) {
  shown = useTimelineSession(props.client, 'test', props.device ?? 'd', props.session ?? 's', props.enabled ?? true)
  return null
}
const render = async (client: SessionpageTimelineClient, props = {}) => {
  await act(async () => { root.render(<Probe client={client} {...props} />) })
}
function fakeClient(older: Promise<TimelineOlderResult>) {
  return { fetchSnapshot: vi.fn(async () => snapshot()), fetchOlder: vi.fn(() => older),
    subscribeSession: vi.fn(async () => ({})), unsubscribeSession: vi.fn(async () => ({})),
    subscribeSessionEvents: (_d: string, _s: string, receive: typeof push) => { push = receive; return () => {} },
    onLinkChange: () => () => {},
  } as unknown as SessionpageTimelineClient
}

it.each(['session', 'device', 'disabled', 'reset'] as const)('rejects an actual older response after %s changes', async change => {
  const late = Promise.withResolvers<TimelineOlderResult>()
  const client = fakeClient(late.promise)
  await render(client)
  expect(shown.phase).toBe('ready')
  let request!: Promise<void>
  act(() => { request = shown.loadOlder() })
  expect(client.fetchOlder).toHaveBeenCalledOnce()
  if (change === 'reset') {
    await act(async () => { push({ ok: false, reset: 'epoch_changed', snapshot: snapshot() }) })
  } else {
    await render(client, change === 'disabled' ? { enabled: false } : { [change]: 'new' })
  }
  await act(async () => { late.resolve({ epoch: 'e', turns: [turn('obsolete')], hasOlder: false }); await request })
  expect(shown.timeline.turns.map(value => value.id)).not.toContain('obsolete')
  expect(shown.actionError).toBeNull()
})

it('rejects a late older error after switching the actual hook to another session', async () => {
  const late = Promise.withResolvers<TimelineOlderResult>()
  const client = fakeClient(late.promise)
  await render(client)
  let request!: Promise<void>
  act(() => { request = shown.loadOlder() })
  await render(client, { session: 'new' })
  await act(async () => { late.reject(new Error('obsolete failure')); await request })
  expect(shown.actionError).toBeNull()
})

// Every delta of a streaming reply is an After that moves the watermark. An older page asked for before it and
// answered after it still belongs where it was asked for: the window's older end has not moved. Dropped, a reader
// could not page up at all while an agent was working.
it('lands an older page that an After overtook, without moving the newer watermark', async () => {
  const late = Promise.withResolvers<TimelineOlderResult>()
  const client = fakeClient(late.promise)
  await render(client)
  let request!: Promise<void>
  act(() => { request = shown.loadOlder() })
  await act(async () => { push({ ok: true, batch: { from: 2, cursor: { epoch: 'e', seq: 3 },
    turns: [], removedTurnIds: [], settlements: [] } }) })
  await act(async () => { late.resolve({ epoch: 'e', turns: [turn('older')], hasOlder: false }); await request })
  expect(shown.timeline.cursor?.seq).toBe(3)
  expect(shown.timeline.turns.map(value => value.id).sort()).toEqual(['current', 'older'])
  expect(shown.timeline.hasOlder).toBe(false)
})

it('still rejects an older page when the After that overtook it resolved a pending ticket', async () => {
  const fields = { resolvedPendingTickets: ['ticket'] }
  const late = Promise.withResolvers<TimelineOlderResult>()
  const client = fakeClient(late.promise)
  await render(client)
  let request!: Promise<void>
  act(() => { request = shown.loadOlder() })
  await act(async () => { push({ ok: true, batch: { from: 2, cursor: { epoch: 'e', seq: 3 },
    turns: [], removedTurnIds: [], settlements: [], ...fields } as unknown as Extract<TimelineAfterResult, { ok: true }>['batch'] }) })
  await act(async () => { late.resolve({ epoch: 'e', turns: [turn('obsolete')], hasOlder: false }); await request })
  expect(shown.timeline.cursor?.seq).toBe(3)
  expect(shown.timeline.turns.map(value => value.id)).not.toContain('obsolete')
})

it('still rejects an older page when the turn it was asked before is gone', async () => {
  const late = Promise.withResolvers<TimelineOlderResult>()
  const client = fakeClient(late.promise)
  await render(client)
  let request!: Promise<void>
  act(() => { request = shown.loadOlder() })
  await act(async () => { push({ ok: true, batch: { from: 2, cursor: { epoch: 'e', seq: 3 },
    turns: [{ ...turn('replacement'), itemIds: [], items: [] }], removedTurnIds: ['current'], settlements: [] } }) })
  await act(async () => { late.resolve({ epoch: 'e', turns: [turn('obsolete')], hasOlder: false }); await request })
  expect(shown.timeline.turns.map(value => value.id)).toEqual(['replacement'])
})
