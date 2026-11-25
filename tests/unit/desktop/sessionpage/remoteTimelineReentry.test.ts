// @vitest-environment jsdom
import 'fake-indexeddb/auto'
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createSessionRecordSource, createSessionTimeline } from '@gugu/session-core/session-record'
import type { RecordCursor, TimelineAfterResult } from '@gugu/session-core/session-record/contract'
import { splitActiveTurn } from '@/components/assistant-ui/transcript-sync'
import { followSessionStream, type TimelineStreamClient } from '@/components/session-watch/use-timeline-session'
import { getAgentWatchStore } from '@/session/shared/remote-sessions/local-store'
import { sessionStreamKey, sessionStreams } from '@/components/session-watch/timeline-cache'

const THREAD_ID = '019ed98a-a0ce-7f63-a9aa-04e0760a80c2'
const disposers: Array<() => void | Promise<void>> = []

afterEach(async () => {
  while (disposers.length) await disposers.pop()?.()
})

function line(at: string, type: string, payload: Record<string, unknown>) {
  return JSON.stringify({ timestamp: `2026-11-25T03:${at}Z`, type, payload }) + '\n'
}

function startTurn(id: string, time: string, text: string) {
  return line(time, 'event_msg', { type: 'task_started', turn_id: id }) +
    line(time, 'response_item', { type: 'message', role: 'user', id: `msg_${id}`, content: [{ type: 'input_text', text }] })
}

function endTurn(id: string, end: string) {
  return line(end, 'event_msg', { type: 'task_complete', turn_id: id })
}

const FIRST_REPLY = 'The reply was persisted'
const firstEnd = line('20:29.815', 'response_item', { type: 'message', role: 'assistant',
  content: [{ type: 'output_text', text: FIRST_REPLY }] }) + endTurn('first', '20:30.563')
const secondStart = startTurn('second', '20:37.778', 'Next request')
const secondEnd = endTurn('second', '23:19.766')

async function setup(name: string) {
  const root = await mkdtemp(join(tmpdir(), 'gugu-codex-reentry-'))
  disposers.push(() => rm(root, { recursive: true, force: true }))
  const day = join(root, '2026', '11', '25')
  await mkdir(day, { recursive: true })
  const file = join(day, `rollout-2026-11-25T03-19-40-${THREAD_ID}.jsonl`)
  await writeFile(file, startTurn('first', '19:40.626', 'First request'))
  const host = await createSessionTimeline(createSessionRecordSource({ harness: 'codex', providerSessionId: THREAD_ID, roots: [root] }), { sessionId: name })
  disposers.push(() => host.dispose())

  const deviceId = 'remote-codex-host'
  const sessionId = name
  const subscriptions = new Map<string, () => void>()
  const listeners = new Map<string, (result: TimelineAfterResult) => void>()
  const wire: { deliver: boolean; acknowledge: boolean; rejectSnapshot: boolean; snapshotGate?: Promise<void> } = {
    deliver: true, acknowledge: true, rejectSnapshot: false,
  }
  const client = {
    reconcileOnSubscribe: true,
    fetchSnapshot: vi.fn(async () => {
      await wire.snapshotGate
      if (wire.rejectSnapshot) throw Object.assign(new Error('Session history unavailable'), { code: 'session_not_found' })
      return host.getSnapshot()
    }),
    fetchAfter: vi.fn(async (_device: string, _session: string, cursor: RecordCursor) => {
      await host.catchUp()
      return host.getAfter(cursor)
    }),
    subscribeSession: vi.fn(async (_device: string, _session: string, id: string, cursor: RecordCursor | null) => {
      subscriptions.set(id, host.subscribe(cursor, (result) => { if (wire.deliver) listeners.get(id)?.(result) }))
      if (!wire.acknowledge) await new Promise<void>(() => undefined)
    }),
    unsubscribeSession: vi.fn(async (_device: string, id: string) => {
      subscriptions.get(id)?.()
      subscriptions.delete(id)
    }),
    subscribeSessionEvents: (_device: string, id: string, receive: (result: TimelineAfterResult) => void) => {
      listeners.set(id, receive)
      return () => { listeners.delete(id) }
    },
    onLinkChange: () => () => undefined,
  } satisfies TimelineStreamClient
  const stream = () => sessionStreams.get()[sessionStreamKey({ deviceId, sessionId })]!
  const open = () => {
    const reader = followSessionStream({ client, deviceId, sessionId, enabled: true, lean: 'folded' }, () => undefined)
    let attached = true
    const leave = () => { if (attached) { attached = false; reader.detach() } }
    disposers.push(leave)
    return leave
  }
  return {
    host, wire, client, stream, open, cacheId: `${deviceId}:${sessionId}`,
    append: async (lines: string) => { await appendFile(file, lines); await host.catchUp() },
    push: (result: TimelineAfterResult) => { for (const receive of listeners.values()) receive(result) },
    texts: () => stream().timeline.turns.flatMap((turn) => turn.items.flatMap((item) => item.kind === 'message' ? [item.text] : [])),
    active: () => splitActiveTurn(stream().timeline.turns).active,
  }
}

it('keeps an already visible Codex reply across a delayed older batch, exit and reentry', async () => {
  const scene = await setup('old-batch')
  const leave = scene.open()
  await vi.waitFor(() => expect(scene.stream().link).toBe('ok'))
  const stale = scene.host.getAfter({ ...scene.host.getCursor(), seq: 0 })

  await scene.append(firstEnd)
  await scene.append(secondStart)
  const current = scene.stream().timeline.cursor
  expect(scene.texts()).toEqual(['First request', FIRST_REPLY, 'Next request'])
  expect(scene.active()?.startedAt).toBe(Date.parse('2026-11-25T03:20:37.778Z'))

  scene.push(stale)
  expect(scene.stream().timeline.cursor).toEqual(current)
  leave()
  scene.open()
  expect(scene.texts()).toEqual(['First request', FIRST_REPLY, 'Next request'])
  await vi.waitFor(() => expect(scene.client.fetchAfter).toHaveBeenCalledTimes(1))
  expect(scene.client.fetchSnapshot).toHaveBeenCalledTimes(1)
})

it('reconciles without a push or its ACK and keeps the last turn ended across a delayed completion batch', async () => {
  const scene = await setup('reconcile')
  const leave = scene.open()
  await vi.waitFor(() => expect(scene.stream().link).toBe('ok'))
  await scene.append(firstEnd)
  await scene.append(secondStart)
  expect(scene.texts()).toContain(FIRST_REPLY)
  const runningCursor = scene.host.getCursor()
  leave()

  await scene.append(secondEnd)
  const delayedEnd = scene.host.getAfter(runningCursor)
  expect(delayedEnd.ok && delayedEnd.batch.turns.at(-1)?.outcome?.kind).toBe('done')
  // A later change advances the host without creating a new active turn.
  scene.host.syncQueuedPrompts([{ id: 'queued', text: 'Queued separately' }])
  scene.wire.deliver = false
  scene.wire.acknowledge = false
  scene.open()

  expect(scene.texts()).toContain(FIRST_REPLY)
  await vi.waitFor(() => expect(scene.active()).toBeNull())
  expect(scene.stream().timeline.cursor).toEqual(scene.host.getCursor())
  expect(scene.stream().timeline.turns.at(-1)?.endedAt).toBe(Date.parse('2026-11-25T03:23:19.766Z'))
  scene.push(delayedEnd)
  expect(scene.active()).toBeNull()
  expect(scene.client.fetchAfter).toHaveBeenCalledTimes(1)
  expect(scene.client.fetchSnapshot).toHaveBeenCalledTimes(1)
})

it.each([false, true])('requests a fresh snapshot after a missing batch (snapshot fails: %s)', async (rejectSnapshot) => {
  const scene = await setup(`gap-${rejectSnapshot}`)
  scene.open()
  await vi.waitFor(() => expect(scene.stream().link).toBe('ok'))
  scene.wire.deliver = false
  await scene.append(firstEnd)
  await scene.append(secondStart)
  scene.wire.deliver = true
  scene.wire.rejectSnapshot = rejectSnapshot
  await scene.append(secondEnd)

  await vi.waitFor(() => expect(scene.client.fetchSnapshot).toHaveBeenCalledTimes(2))
  if (rejectSnapshot) {
    await vi.waitFor(() => expect(scene.stream().phase).toBe('error'))
    expect(scene.stream().error).toBeTruthy()
    expect(scene.texts()).toEqual(['First request'])
    expect(scene.client.subscribeSession).toHaveBeenCalledTimes(1)
  } else {
    await vi.waitFor(() => expect(scene.stream().link).toBe('ok'))
    expect(scene.texts()).toEqual(['First request', FIRST_REPLY, 'Next request'])
    expect(scene.active()).toBeNull()
    expect(scene.client.subscribeSession.mock.lastCall?.[3]).toEqual(scene.host.getCursor())
  }
})

it('repairs a corrupt legacy IndexedDB entry and follows a new input and reply', async () => {
  const scene = await setup('legacy-cache')
  const staleTurns = scene.host.getSnapshot().turns
  await scene.append(firstEnd)
  await scene.append(secondStart + secondEnd)
  const latestCursor = scene.host.getCursor()
  const store = await getAgentWatchStore()
  // This is the old receiver's failure mode: old turn contents paired with the host's latest cursor.
  await store.put('timeline', { key: scene.cacheId, savedAt: Date.now(), turns: staleTurns, cursor: latestCursor,
    settlements: {}, hasOlder: false })
  let releaseSnapshot!: () => void
  scene.wire.snapshotGate = new Promise<void>((resolve) => { releaseSnapshot = resolve })

  const leave = scene.open()
  await vi.waitFor(() => expect(scene.client.fetchSnapshot).toHaveBeenCalledTimes(1))
  expect(scene.texts()).toEqual(['First request'])
  expect(scene.stream().timeline.cursor).toBeNull()
  expect(scene.client.subscribeSession).not.toHaveBeenCalled()

  // A new input and reply land while the reader is recovering.
  await scene.append(startTurn('third', '42:00.000', 'hello') +
    line('42:01.000', 'response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Hello back' }] }) +
    endTurn('third', '42:02.000'))
  releaseSnapshot()
  await vi.waitFor(() => expect(scene.stream().link).toBe('ok'))
  expect(scene.texts()).toEqual(['First request', FIRST_REPLY, 'Next request', 'hello', 'Hello back'])
  expect(scene.active()).toBeNull()

  await scene.append(startTurn('fourth', '43:00.000', 'Continue after recovery'))
  expect(scene.texts().at(-1)).toBe('Continue after recovery')
  expect(scene.active()?.startedAt).toBe(Date.parse('2026-11-25T03:43:00.000Z'))
  await scene.append(endTurn('fourth', '43:01.000'))
  expect(scene.active()).toBeNull()
  leave()

  // Drop the in-memory layer so the next open really uses the new IndexedDB row.
  await vi.waitFor(async () => expect((await store.read('timeline', scene.cacheId))?.cursor).toEqual(scene.host.getCursor()))
  const { forgetInMemoryTimelines } = await import('@/components/session-watch/timeline-cache')
  forgetInMemoryTimelines()
  scene.open()
  await vi.waitFor(() => expect(scene.client.fetchAfter).toHaveBeenCalledTimes(1))
  expect(scene.client.fetchSnapshot).toHaveBeenCalledTimes(1)
  expect(scene.texts()).toContain(FIRST_REPLY)
})
