// @vitest-environment jsdom
// A task on another machine opens on the timeline page; once its workspace is ready the session page takes over. Both
// read one stream: the session page continues from the copy the timeline page holds, ❌ reads the first page again.
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { TimelineAfterResult } from '@gugu/session-core/session-record'

const host = vi.hoisted(() => ({ snapshots: 0, afters: 0, subscribedFrom: [] as unknown[], reopened: new Set<() => void>(), away: false }))
const turn = (id: string) => ({ id, role: 'assistant', startedAt: 1, outcome: null, itemIds: [], items: [] }) as unknown as TranscriptTurn
const snapshot = () => {
  host.snapshots += 1
  return { cursor: { epoch: 'e', seq: 3 }, turns: [turn('t1'), turn('t2')], settlements: [], hasOlder: false }
}
// The session page reaches the machine through its own line (`rpcOn`): same host answers as the timeline page's client.
vi.mock('@renderer/lib/ipc', () => ({
  rpcOn: () => ({ sessionTimeline: {
    sessionSnapshot: async () => {
      if (host.away) throw Object.assign(new Error('Could not reach dev.'), { code: 'unreachable' })
      return { ok: true, value: snapshot() }
    },
    sessionAfter: async () => { host.afters += 1; return { ok: false, error: { code: 'unexpected', message: 'not asked here' } } },
    sessionSubscribe: async (input: { cursor: unknown }) => { host.subscribedFrom.push(input.cursor); return { ok: true, value: null } },
    sessionUnsubscribe: async () => undefined,
  } }),
  onMachineEvent: () => () => undefined,
}))
vi.mock('@renderer/lib/machine-clients', () => ({
  machineLinkState: () => 'open',
  subscribeMachineLink: () => () => undefined,
  onMachineReconnected: (_machine: string, cb: () => void) => { host.reopened.add(cb); return () => host.reopened.delete(cb) },
}))

const { followSessionStream } = await import('@/components/session-watch/use-timeline-session')
const { RemoteTimelineFeed } = await import('../../../../apps/desktop/src/session/renderer/features/sessions/acp/remote-timeline-feed')
const { sessionStreams, sessionStreamKey } = await import('@/components/session-watch/timeline-cache')

/** The timeline page's own client (the phone / peek one). */
const pageClient = {
  fetchSnapshot: async () => snapshot(),
  fetchAfter: async () => { host.afters += 1; throw new Error('not asked here') },
  subscribeSession: async (_d: string, _s: string, _id: string, cursor: unknown) => { host.subscribedFrom.push(cursor) },
  unsubscribeSession: async () => undefined,
  subscribeSessionEvents: () => () => undefined,
  onLinkChange: () => () => undefined,
}

async function timelinePage(sessionId: string) {
  const page = followSessionStream({ client: pageClient, deviceId: 'dev', sessionId, enabled: true, lean: 'folded' }, () => undefined)
  await vi.waitFor(() => expect(sessionStreams.get()[sessionStreamKey({ deviceId: 'dev', sessionId })]?.phase).toBe('ready'))
  return page
}

describe('the session page of a remote task takes over the timeline page\'s stream', () => {
  it('while the timeline page still holds it: no read at all', async () => {
    host.snapshots = 0; host.afters = 0; host.subscribedFrom = []
    const page = await timelinePage('s-held')
    const feed = new RemoteTimelineFeed('s-held', 'dev', () => undefined, () => undefined)
    await feed.open()
    page.detach()
    expect(host.snapshots).toBe(1)
    expect(feed.state.turns.map((t) => t.id)).toEqual(['t1', 't2'])
    feed.close()
  })

  it('after the timeline page let go: it subscribes from the cursor that page held, ❌ a second first page', async () => {
    host.snapshots = 0; host.afters = 0; host.subscribedFrom = []
    const page = await timelinePage('s-let-go')
    page.detach()
    const feed = new RemoteTimelineFeed('s-let-go', 'dev', () => undefined, () => undefined)
    await feed.open()
    // It shows that copy at once; the subscription from its cursor follows (the timeline page's, then this page's).
    await vi.waitFor(() => expect(host.subscribedFrom).toHaveLength(2))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(host.snapshots).toBe(1)
    expect(host.subscribedFrom.at(-1)).toEqual({ epoch: 'e', seq: 3 })
    // The host pushes what came after that cursor when it takes the subscription: ❌ asked for again.
    expect(host.afters).toBe(0)
    expect(feed.state.turns.map((t) => t.id)).toEqual(['t1', 't2'])
    feed.close()
  })

  it('a push of another epoch (a stand-in replaced by its record): subscribes again, the copy held stays shown meanwhile', async () => {
    host.snapshots = 0; host.afters = 0; host.subscribedFrom = []
    let push: (result: TimelineAfterResult) => void = () => undefined
    const client = { ...pageClient, subscribeSessionEvents: (_d: string, _id: string, receive: (result: TimelineAfterResult) => void) => { push = receive; return () => undefined } }
    const page = followSessionStream({ client, deviceId: 'dev', sessionId: 's-replaced', enabled: true, lean: 'folded' }, () => undefined)
    const key = sessionStreamKey({ deviceId: 'dev', sessionId: 's-replaced' })
    await vi.waitFor(() => expect(host.subscribedFrom).toHaveLength(1))
    push({ ok: false, reset: 'epoch_changed', snapshot: { cursor: { epoch: 'e', seq: 4 }, turns: [turn('t1'), turn('t2')], settlements: [], hasOlder: false, runningTurnId: 't2' } })
    const shown: Array<string | null | undefined> = []
    const stop = sessionStreams.subscribe(() => { shown.push(sessionStreams.get()[key]?.timeline.runningTurnId) })
    push({ ok: true, batch: { from: 0, cursor: { epoch: 'e:replaced', seq: 0 }, turns: [], removedTurnIds: [], settlements: [] } })
    await vi.waitFor(() => expect(host.subscribedFrom).toHaveLength(2))
    stop()
    expect(shown.every((id) => id === 't2')).toBe(true)
    page.detach()
  })

  it('a new window on that machine (a planned switch of channel, the link says open throughout): subscribes again', async () => {
    host.snapshots = 0; host.afters = 0; host.subscribedFrom = []
    const page = await timelinePage('s-switched')
    page.detach()
    const feed = new RemoteTimelineFeed('s-switched', 'dev', () => undefined, () => undefined)
    await feed.open()
    await vi.waitFor(() => expect(host.subscribedFrom).toHaveLength(2))
    const before = host.subscribedFrom.length
    for (const reopened of [...host.reopened]) reopened()
    // That machine dropped the old window's subscription: ❌ the page waits on it for good.
    await vi.waitFor(() => expect(host.subscribedFrom.length).toBeGreaterThan(before))
    feed.close()
  })
})

// Its machine does not answer when the page opens: the failure keeps its code, so the page waits for that machine and opens
// again when it is back (acp-load-error `connection_lost`), ❌ a history failure that stays until someone clicks.
it('an unreachable machine stays a lost line', async () => {
  host.away = true
  const feed = new RemoteTimelineFeed('s-away', 'dev', () => undefined, () => undefined)
  await expect(feed.open()).rejects.toMatchObject({ code: 'unreachable' })
  feed.close()
  host.away = false
})
