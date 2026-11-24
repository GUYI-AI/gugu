// @vitest-environment jsdom
// A task on another machine opens on the timeline page; once its workspace is ready the session page takes over. Both
// read one stream: the session page continues from the copy the timeline page holds, ❌ reads the first page again.
import { describe, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'

const host = vi.hoisted(() => ({ snapshots: 0, afters: 0, subscribedFrom: [] as unknown[], away: false }))
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
vi.mock('@renderer/lib/machine-clients', () => ({ machineLinkState: () => 'open', subscribeMachineLink: () => () => undefined }))

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
