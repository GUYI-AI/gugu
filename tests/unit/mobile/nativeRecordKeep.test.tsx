// @vitest-environment jsdom
import { act } from 'react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { NativeSessionRecord } from '@gugu/session-core/session-record/contract'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { createReactHarness } from '../../support/testHarness'
import { useNativeSessionRecord } from '../../../apps/desktop/src/mobile/agent-watch/useNativeSessionRecord'
import { clearTimelineCache, forgetInMemoryTimelines, hydrateCachedNativeRecord, writeCachedNativeRecord } from '../../../apps/desktop/src/mobile/agent-watch/timeline-cache'
import { checkNativeRevisions, replaceNativeRecordTurns } from '../../../apps/desktop/src/mobile/agent-watch/native-record-state'
import { getAgentWatchStore } from '../../../apps/desktop/src/session/shared/remote-sessions/local-store'

// owner 2026-11-12 「读过的历史存进手机、下次打开不用再请求」: what the phone read is kept on it, and opening asks
// only for the turns after it and for the revision of each held turn; only a turn the host rewrote is read again.
const scope = vi.hoisted(() => ({ read: vi.fn() }))
vi.mock('../../../apps/desktop/src/mobile/agent-watch/sessionpage-rpc', () => ({ machineRpc: () => ({ sessionTimeline: { sessionNativeRecord: scope.read } }),
  onLinkChange: () => () => {} }))

const turn = (seq: number, text = `turn ${seq}`): TranscriptTurn => ({ id: `s:turn:s${seq}`, seq, initiator: 'user',
  items: [{ kind: 'message', id: `s:turn:s${seq}:m`, role: 'user', text }] } as unknown as TranscriptTurn)
const record = (from: number, to: number, revision = (_seq: number) => 0): NativeSessionRecord => {
  const turns = Array.from({ length: to - from + 1 }, (_, i) => turn(from + i))
  return { latestStoredSeq: to, hasNewer: false, turns, originTurnIds: turns.map(one => one.id), nextCursor: from || null, activeTurn: null,
    turnRevisions: turns.map(one => revision(one.seq)) }
}
let harness: ReturnType<typeof createReactHarness>
beforeEach(async () => { harness = createReactHarness(); await clearTimelineCache() })
afterEach(() => { harness.cleanup(); scope.read.mockReset(); vi.useRealTimers() })

it('lets go of a held turn the host no longer has and names the ones it rewrote', () => {
  const held = record(10, 14) as NativeSessionRecord & { turnRevisions: number[] }
  const checked = checkNativeRevisions(held, [[10, 0], [11, 3], [13, 0], [14, 0]], 11)
  expect(checked.stale).toEqual([11])
  expect(checked.record.turns.map(one => one.seq)).toEqual([10, 11, 13, 14])
  const fresh = { ...record(11, 11, () => 3), turns: [turn(11, 'rewritten')] }
  const next = replaceNativeRecordTurns(checked.record, [11], [fresh])
  expect(next.turns[1]).toMatchObject({ seq: 11, items: [{ text: 'rewritten' }] })
  expect(next.turnRevisions).toEqual([0, 3, 0, 0])
  // Asked for, but its read ended at another turn: no longer shown by the host, so let go instead of asked for forever.
  expect(replaceNativeRecordTurns(checked.record, [13], [record(12, 12)]).turns.map(one => one.seq)).toEqual([10, 11, 14])
})

it('reopening draws the stored turns and reads only the new ones and the one rewritten since', async () => {
  vi.useFakeTimers()
  writeCachedNativeRecord({ deviceId: 'keep-host', sessionId: 'keep' }, record(0, 199))
  forgetInMemoryTimelines() // A cold start: what was read is on this phone, not in memory.
  scope.read.mockImplementation(async (input: { after?: number; before?: number; tail?: boolean; revisionsFrom?: number }) => {
    if (input.revisionsFrom !== undefined) {
      const page = record((input.after ?? -1) + 1, 201, seq => seq === 150 ? 1 : 0)
      const revisions = Array.from({ length: 202 - input.revisionsFrom }, (_, i): [number, number] => [input.revisionsFrom! + i, input.revisionsFrom! + i === 150 ? 1 : 0])
      return { ok: true, value: { ...page, nextCursor: null, revisions } }
    }
    if (input.before === 151) return { ok: true, value: { ...record(150, 150, () => 1), turns: [turn(150, 'rewritten on the host')] } }
    return { ok: true, value: record(142, 201) }
  })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('keep-host', 'keep', true, true); return null }
  await harness.render(<Fixture />)
  await act(async () => { await vi.advanceTimersByTimeAsync(0) })
  await vi.waitFor(() => expect(state.ready).toBe(true))
  const asked = scope.read.mock.calls.map(([input]) => input as Record<string, unknown>)
  expect(asked.some(input => input.tail), 'the newest page is not read again over what is held').toBe(false)
  expect(asked[0]).toMatchObject({ after: 199, revisionsFrom: 0 })
  expect(asked.slice(1)).toEqual([expect.objectContaining({ before: 151, limit: 1 })])
  expect(state.record?.turns.map(one => one.seq)).toEqual(Array.from({ length: 202 }, (_, i) => i))
  expect(state.record?.turns[150]?.items[0]).toMatchObject({ text: 'rewritten on the host' })

  // A poll asks for the turns after the newest and checks only the newest few.
  scope.read.mockClear()
  await act(async () => { await vi.advanceTimersByTimeAsync(1000) })
  expect(scope.read.mock.calls.map(([input]) => input)).toEqual([expect.objectContaining({ after: 201, revisionsFrom: 172 })])
})

it('a host from before revisions is read the way it was: the newest page', async () => {
  writeCachedNativeRecord({ deviceId: 'old-host', sessionId: 'keep' }, record(0, 99))
  forgetInMemoryTimelines()
  scope.read.mockImplementation(async (input: { tail?: boolean; after?: number }) => {
    const { turnRevisions: _turnRevisions, ...page } = record(input.tail ? 40 : (input.after ?? -1) + 1, 99)
    return { ok: true, value: page }
  })
  let state!: ReturnType<typeof useNativeSessionRecord>
  function Fixture() { state = useNativeSessionRecord('old-host', 'keep', true, true); return null }
  await harness.render(<Fixture />)
  await vi.waitFor(() => expect(scope.read.mock.calls.some(([input]) => (input as { tail?: boolean }).tail)).toBe(true))
  await vi.waitFor(() => expect(state.ready).toBe(true))
})

it('stores a conversation in chunks and rewrites only the chunk a change touched', async () => {
  const key = { deviceId: 'chunk-host', sessionId: 'chunks' }
  const store = await getAgentWatchStore()
  const put = vi.spyOn(store, 'put')
  const first = record(0, 119)
  writeCachedNativeRecord(key, first)
  await vi.waitFor(() => expect(put.mock.calls.map(([, row]) => row.key)).toContain('native:chunk-host:chunks'))
  expect(put.mock.calls.map(([, row]) => row.key).filter(row => row.includes('#'))).toEqual(['native:chunk-host:chunks#2', 'native:chunk-host:chunks#1', 'native:chunk-host:chunks#0'])
  put.mockClear()
  const turns = [...first.turns]; turns[60] = turn(60, 'changed')
  writeCachedNativeRecord(key, { ...first, turns })
  await vi.waitFor(() => expect(put.mock.calls.map(([, row]) => row.key)).toContain('native:chunk-host:chunks'))
  expect(put.mock.calls.map(([, row]) => row.key).filter(row => row.includes('#'))).toEqual(['native:chunk-host:chunks#1'])
  forgetInMemoryTimelines()
  const stored = await hydrateCachedNativeRecord(key)
  expect(stored?.turns).toHaveLength(120)
  expect(stored?.turns[60]?.items[0]).toMatchObject({ text: 'changed' })
  expect(stored?.turnRevisions).toEqual(first.turnRevisions)
  put.mockRestore()
})

it('still reads a conversation stored whole by an earlier version', async () => {
  const store = await getAgentWatchStore()
  const old = record(0, 9)
  await store.put('timeline', { key: 'native:whole-host:old', savedAt: 1, record: old, bytes: 1 })
  expect((await hydrateCachedNativeRecord({ deviceId: 'whole-host', sessionId: 'old' }))?.turns).toHaveLength(10)
})
