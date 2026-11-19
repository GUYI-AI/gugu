// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TimelineAfterResult, TimelineSnapshot } from '@gugu/session-core/session-record/contract'
import { useTimelineSession, type AgentWatchSession, type SessionpageTimelineClient } from '../../../apps/desktop/src/mobile/agent-watch/use-timeline-session'
import { clearTimelineCache } from '../../../apps/desktop/src/mobile/agent-watch/timeline-cache'
import { createNode, createReactHarness } from '../../support/testHarness'

/**
 * Review 6: the same session open in two panels is one follow of its host stream (ref-counted per session): the host
 * is subscribed once, both panels draw the same updates, and the first one leaving does not stop the second.
 */
const SNAPSHOT: TimelineSnapshot = {
  cursor: { epoch: 'e1', seq: 10 },
  turns: [{ id: 'a', seq: 1, initiator: 'user', items: [{ kind: 'message', id: 'a-m', seq: 0, role: 'user', text: '行程单' }] }],
  settlements: [],
  hasOlder: false,
}
const pushed = (seq: number, text: string): TimelineAfterResult => ({
  ok: true,
  batch: { from: seq - 1, cursor: { epoch: 'e1', seq }, removedTurnIds: [], settlements: [],
    turns: [{ id: `t${seq}`, seq, initiator: 'agent', itemIds: [`t${seq}-m`], items: [{ kind: 'message', id: `t${seq}-m`, seq: 0, role: 'assistant', text }] }] },
})

function fakeClient() {
  const pushes = new Map<string, (result: TimelineAfterResult) => void>()
  const client = {
    fetchSnapshot: vi.fn(async () => SNAPSHOT),
    fetchAfter: vi.fn(async () => ({ ok: true, batch: { from: 10, cursor: { epoch: 'e1', seq: 10 }, turns: [], removedTurnIds: [], settlements: [] } })),
    fetchOlder: vi.fn(),
    subscribeSession: vi.fn(async () => ({})),
    unsubscribeSession: vi.fn(async () => ({})),
    subscribeSessionEvents: vi.fn((_device: string, subscriptionId: string, onResult: (result: TimelineAfterResult) => void) => {
      pushes.set(subscriptionId, onResult)
      return () => { pushes.delete(subscriptionId) }
    }),
    onLinkChange: vi.fn(() => () => undefined),
    sendSessionText: vi.fn(),
    cancelSessionTurn: vi.fn(),
    respondToSettlement: vi.fn(),
  }
  return { client: client as unknown as SessionpageTimelineClient, raw: client, push: (result: TimelineAfterResult) => { for (const deliver of pushes.values()) deliver(result) } }
}

const sessions: Record<string, AgentWatchSession> = {}
const firstFrames: Record<string, { phase: string; error: string | null }> = {}
function Panel({ name, client, enabled = true }: { name: string; client: SessionpageTimelineClient; enabled?: boolean }) {
  const session = useTimelineSession(client, 'phone', 'machine-1', 'conversation-1', enabled)
  firstFrames[name] ??= { phase: session.phase, error: session.error }
  sessions[name] = session
  return null
}
const texts = (session: AgentWatchSession) => session.timeline.turns.flatMap((turn) => turn.items.map((item) => ('text' in item ? item.text : '')))

let first: ReturnType<typeof createReactHarness>
let second: ReturnType<typeof createReactHarness>
beforeEach(async () => {
  await clearTimelineCache()
  first = createReactHarness()
  second = createReactHarness()
})
afterEach(() => { first.cleanup(); second.cleanup() })

describe('one session in two panels', () => {
  it('subscribes the host once, draws the same updates in both, and keeps following after the first panel leaves', async () => {
    const f = fakeClient()
    await first.render(createNode(Panel, { name: 'left', client: f.client }))
    await second.render(createNode(Panel, { name: 'right', client: f.client }))
    await vi.waitFor(() => expect(sessions.right!.phase).toBe('ready'))
    expect(f.raw.subscribeSession).toHaveBeenCalledTimes(1)
    expect(f.raw.fetchSnapshot).toHaveBeenCalledTimes(1)
    expect(f.raw.subscribeSessionEvents).toHaveBeenCalledTimes(1)

    await act(async () => { f.push(pushed(11, 'first update')) })
    expect(texts(sessions.left!)).toEqual(['行程单', 'first update'])
    expect(texts(sessions.right!)).toEqual(['行程单', 'first update'])

    first.cleanup()
    expect(f.raw.unsubscribeSession).not.toHaveBeenCalled()
    await act(async () => { f.push(pushed(12, 'second update')) })
    expect(texts(sessions.right!)).toEqual(['行程单', 'first update', 'second update'])

    second.cleanup()
    expect(f.raw.unsubscribeSession).toHaveBeenCalledTimes(1)
  })

  it('F2-1: two pages with different clients and one not able to reach the machine are still one follow of the stream', async () => {
    const f = fakeClient()
    const other = fakeClient()
    await second.render(createNode(Panel, { name: 'page', client: other.client }))
    await vi.waitFor(() => expect(sessions.page!.phase).toBe('ready'))
    await first.render(createNode(Panel, { name: 'card', client: f.client, enabled: false }))
    // The page that reaches the machine follows it; the card draws the same entry (❌ written over with "lost").
    expect(other.raw.subscribeSession).toHaveBeenCalledTimes(1)
    expect(f.raw.subscribeSession).not.toHaveBeenCalled()
    await act(async () => { other.push(pushed(11, 'update')) })
    expect(texts(sessions.card!)).toEqual(['行程单', 'update'])
    expect(sessions.card!.link).not.toBe('lost')
  })
})

describe('reopening a session', () => {
  it('F2-2: the first frame of a reopened session is loading, ❌ the error page the last visit ended on', async () => {
    const f = fakeClient()
    f.raw.fetchSnapshot.mockRejectedValue(Object.assign(new Error('not allowed'), { code: 'permission_denied' }))
    await first.render(createNode(Panel, { name: 'visit', client: f.client }))
    await vi.waitFor(() => expect(sessions.visit!.phase).toBe('error'))
    first.cleanup()
    f.raw.fetchSnapshot.mockReturnValue(new Promise(() => {}))
    await second.render(createNode(Panel, { name: 'again', client: f.client }))
    expect(firstFrames.again).toEqual({ phase: 'loading', error: null })
  })
})
