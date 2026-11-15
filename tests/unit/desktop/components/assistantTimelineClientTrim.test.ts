import { beforeEach, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const calls: { route: string; input: unknown }[] = []
  const route = (name: string) => vi.fn((input: unknown) => { calls.push({ route: name, input }); return Promise.resolve({ ok: true, value: { route: name } }) })
  const sessionTimeline: Record<string, (input: unknown) => Promise<unknown>> = Object.fromEntries(
    ['sessionSnapshot', 'sessionAfter', 'sessionOlder', 'sessionSubscribe', 'sessionBackgroundTasks', 'sessionStopBackgroundTask', 'sessionWindowSnapshot', 'sessionWindowAfter', 'sessionWindowOlder', 'sessionWindowSubscribe', 'sessionUnsubscribe'].map((n) => [n, route(n)]),
  )
  // The host's word on how a window opening is followed: a stopped session as a window, any other through the ordinary timeline.
  const opening = { source: 'window' as 'window' | 'legacy' }
  sessionTimeline.sessionWindowPrepare = (input: unknown) => {
    calls.push({ route: 'sessionWindowPrepare', input })
    return Promise.resolve({ ok: true, value: opening.source === 'legacy' ? { source: 'legacy' } : { source: 'window', liveCursor: { workerEpoch: 'w', storeEpoch: 's', sequence: 0 } } })
  }
  const statusListeners: { topic: string; listener: (status: unknown) => void }[] = []
  return { calls, sessionTimeline, opening, statusListeners }
})
vi.mock('../../../../apps/desktop/src/session/renderer/lib/ipc', () => ({ rpcOn: () => ({ sessionTimeline: mocks.sessionTimeline }), events: { on: (_channel: unknown, listener: (status: unknown) => void, topic: string) => {
  const entry = { topic, listener }
  mocks.statusListeners.push(entry)
  return () => { mocks.statusListeners.splice(mocks.statusListeners.indexOf(entry), 1) }
} } }))
vi.mock('../../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ fetchSnapshot: vi.fn(), machineRpc: () => ({ sessionTimeline: mocks.sessionTimeline }), onLinkChange: () => () => {}, unsubscribeSession: (_d: string, id: string) => mocks.sessionTimeline.sessionUnsubscribe({ subscriptionId: id }) }))
vi.mock('../../../../apps/desktop/src/session/shared/core/session-timeline/sessionTimelineEvents', () => ({ sessionpageSessionTimelineChannel: { name: 'x' }, sessionpageSessionWindowStatusChannel: { name: 'status' } }))

import { assistantTimelineClient } from '../../../../apps/desktop/src/components/assistant/assistantTimelineClient'

beforeEach(() => { mocks.calls.length = 0; mocks.opening.source = 'window'; mocks.statusListeners.length = 0 })

it('reads a local session whole when asked (trim:false), so a long message_send reply survives', async () => {
  const client = assistantTimelineClient(true, { trim: false })
  await client.fetchSnapshot('d', 's')
  await client.fetchAfter('d', 's', {} as never)
  await client.fetchOlder('d', 's', 't1')
  await client.subscribeSession('d', 's', 'sub', null)
  expect(mocks.calls.map((c) => (c.input as { trim: boolean }).trim)).toEqual([false, false, false, false])
  expect(assistantTimelineClient(true, { trim: false })).toBe(client)
})

it('keeps trimming by default', async () => {
  await assistantTimelineClient(true).fetchSnapshot('d', 's')
  expect((mocks.calls[0]!.input as { trim: boolean }).trim).toBe(true)
})

it('asks this computer which background commands still run, and stops one', async () => {
  const client = assistantTimelineClient(true)
  await client.fetchBackgroundTasks!('d', 's')
  await client.stopBackgroundTask!('d', 's', 'b1')
  expect(mocks.calls).toEqual([
    { route: 'sessionBackgroundTasks', input: { conversationId: 's' } },
    { route: 'sessionStopBackgroundTask', input: { conversationId: 's', stopId: 'b1' } },
  ])
})

it.each([true, false])('uses bounded routes for every desktop history operation (local=%s)', async local => {
  const client = assistantTimelineClient(local, { window: true })
  await client.fetchSnapshot('d', 's')
  await client.fetchAfter('d', 's', { epoch: 'e', seq: 0 })
  await client.fetchOlder('d', 's', 't')
  await client.subscribeSession('d', 's', 'sub', null)
  await client.unsubscribeSession('d', 'sub')
  expect(mocks.calls.map(call => call.route)).toEqual(['sessionWindowSnapshot', 'sessionWindowAfter',
    'sessionWindowOlder', 'sessionWindowPrepare', 'sessionWindowSubscribe', 'sessionUnsubscribe'])
  expect(client.boundedWindow).toBe(true)
  expect(assistantTimelineClient(local, { window: true })).toBe(client)
})

it.each([true, false])('asks the host to prepare a window opening before subscribing to it, under the same subscription id (local=%s)', async local => {
  await assistantTimelineClient(local, { window: true }).subscribeSession('d', 's', 'sub', null)
  expect(mocks.calls).toEqual([
    { route: 'sessionWindowPrepare', input: { conversationId: 's', subscriptionId: 'sub' } },
    { route: 'sessionWindowSubscribe', input: { conversationId: 's', subscriptionId: 'sub', cursor: null } },
  ])
})

it('follows a session the host does not open as a window through the ordinary timeline, reads and all', async () => {
  mocks.opening.source = 'legacy'
  const client = assistantTimelineClient(true, { window: true })
  await client.subscribeSession('d', 'running', 'sub', { epoch: 'window', seq: 1 })
  await client.fetchAfter('d', 'running', { epoch: 'legacy', seq: 4 })
  await client.fetchOlder('d', 'running', 'turn')
  await client.fetchSnapshot('d', 'other')
  expect(mocks.calls.map(call => call.route)).toEqual(['sessionWindowPrepare', 'sessionSubscribe', 'sessionAfter', 'sessionOlder', 'sessionWindowSnapshot'])
  // The next opening asks again: the session has stopped, and its window is followed as a window.
  mocks.opening.source = 'window'
  mocks.calls.length = 0
  await client.subscribeSession('d', 'running', 'again', null)
  await client.fetchAfter('d', 'running', { epoch: 'window', seq: 2 })
  expect(mocks.calls.map(call => call.route)).toEqual(['sessionWindowPrepare', 'sessionWindowSubscribe', 'sessionWindowAfter'])
})

it('says when this computer ends a window subscription, under that subscription only', () => {
  const failures: unknown[] = []
  const stop = assistantTimelineClient(true, { window: true }).subscribeSessionErrors!('d', 'sub', error => failures.push(error))
  const error = { code: 'scope_changed', message: 'The stopped session changed while opening history' }
  expect(mocks.statusListeners.map(entry => entry.topic)).toEqual(['sub'])
  mocks.statusListeners[0]!.listener({ conversationId: 's', subscriptionId: 'sub', state: 'failed', error })
  expect(failures).toEqual([error])
  stop()
  expect(mocks.statusListeners).toEqual([])
  // Another computer's subscription has no such channel here.
  expect(assistantTimelineClient(false, { window: true }).subscribeSessionErrors).toBeUndefined()
})
