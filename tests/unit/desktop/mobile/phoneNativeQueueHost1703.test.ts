// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { TimelineSnapshot, TimelineAfterResult } from '@gugu/session-core/session-record/contract'
import type { SessionInput } from '@/lib/sessionInput'
import { changed, inputOf, state, SESSION_INPUT, type SessionSend } from '@/lib/outbox/kinds/sessionInput'
import { installSessionInputOutbox, settle, type InstalledSessionInputs } from '../../../helpers/sessionInputOutbox'
import { watchPhoneSessionSendQueues } from '@/components/session-watch/phone-send-queue-host'

const remote = vi.hoisted(() => ({
  snapshot: vi.fn(), history: vi.fn(), life: vi.fn(), report: vi.fn(),
  // The timeline's snapshot apart from its turns, which `history` answers.
  base: null as unknown as TimelineSnapshot,
  events: new Map<string, (data: never) => void>(),
  link: (_open: boolean) => {},
  directoryChanged: () => {}, runtime: 'acp' as 'acp' | 'pty' | null,
  timeline: (_result: TimelineAfterResult) => {},
}))
vi.mock('@/components/session-watch/sessionpage-rpc', () => ({
  machineRpc: () => ({ sessions: { lifeView: remote.life } }),
  fetchSnapshot: remote.snapshot,
  subscribeSession: async () => {}, unsubscribeSession: async () => {},
  subscribeSessionEvents: (_device: string, _id: string, listener: typeof remote.timeline) => { remote.timeline = listener; return () => {} }, subscribeSessionErrors: () => () => {},
  onLinkChange: (_id: string, listener: typeof remote.link) => { remote.link = listener; return () => {} },
  onMachineEvent: (_id: string, channel: { name: string }, listener: (data: never) => void) => {
    remote.events.set(channel.name, listener); return () => remote.events.delete(channel.name)
  },
}))
vi.mock('@/mobile/local-agent/phoneTimelineClient', () => ({ phoneTimelineClient: {} }))
vi.mock('@/store/devicesCache', () => ({ devicesModel: { subscribe: () => () => {} } }))
vi.mock('@/session/shared/remote-sessions/session-directory', () => ({
  directoryDevices: () => [{ device_id: 'host', is_online: true, capabilities: {} }],
  liveDeviceSessions: () => ({ host: { cached: false, connected: true, sessions: remote.runtime ? [
    { conversationId: 'session', runtime: remote.runtime, nativeInputVersion: 2 },
  ] : [] } }),
  requestPhoneTaskDirectory: () => () => {}, subscribeDeviceSessions: (listener: () => void) => { remote.directoryChanged = listener; return () => {} },
}))
vi.mock('@/lib/log', () => ({ rendererLogger: () => ({ warn: remote.report }) }))

const turn = (id: string, outcome?: TranscriptTurn['outcome']): TranscriptTurn => ({ id, seq: 0, initiator: 'user', items: [], ...(outcome ? { outcome } : {}) })
/** The session's turns as its timeline holds them: the committed ones, then the running one. */
const record = (turns: TranscriptTurn[], activeTurn: TranscriptTurn | null = null): TranscriptTurn[] => [...turns, ...(activeTurn ? [activeTurn] : [])]
let installed: InstalledSessionInputs, stop: (() => void) | undefined
const delivered = vi.fn<(input: SessionInput) => Promise<void>>()
const first: SessionSend = { deviceId: 'host', sessionId: 'session', text: 'same', createdAt: 1, queued: true, sendQueue: { order: 1 } }
/** The outbox's own row, whatever the rows view currently shows. */
const read = (id: string) => { const item = installed.outbox.get<SessionSend>(id); return item ? inputOf(item) : undefined }
beforeEach(async () => {
  vi.clearAllMocks(); remote.events.clear(); remote.runtime = 'acp'
  delivered.mockResolvedValue(undefined)
  installed = installSessionInputOutbox({ send: input => delivered(input) })
  await installed.outbox.enqueue(SESSION_INPUT, first, { id: 'first', hold: true })
  remote.life.mockResolvedValue({ kind: 'ready', hold: null })
  remote.base = { cursor: { epoch: 'provider', seq: 1 }, turns: [], queuedPrompts: [], settlements: [], liveReply: null, hasOlder: false }
  remote.snapshot.mockImplementation(async () => {
    const read = await remote.history()
    if (!read.ok) throw Object.assign(new Error(read.error.message), { code: read.error.code })
    return { ...remote.base, turns: read.value }
  })
  remote.history.mockResolvedValue({ ok: true, value: record([turn('native-completed', { kind: 'done', reason: 'end_turn' })]) })
})
afterEach(() => {
  stop?.(); stop = undefined
  installed.dispose()
})

it('drains the actual persistent outbox without a task page', async () => {
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
  expect(delivered.mock.calls[0][0]).toMatchObject({ id: 'first', queued: false })
  expect(delivered.mock.calls[0][0].steerIfBusy).toBeUndefined()
  expect(remote.report).not.toHaveBeenCalled()
})

it('does not release while the timeline\'s last turn is still running', async () => {
  remote.history.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.snapshot).toHaveBeenCalled())
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  expect(read('first')?.sendQueue).toBeDefined()
})

it('releases after native persistence even when the provider emits no completion event', async () => {
  remote.history.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  expect(delivered).not.toHaveBeenCalled()
  remote.history.mockResolvedValue({ ok: true, value: record([turn('current-native', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'native-source', status: 'persisted' } as never)
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it.each(['cancelled', 'error'] as const)('retains the input after native %s', async kind => {
  remote.history.mockResolvedValue({ ok: true, value: record([turn('current-native', { kind })]) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalled())
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  expect(read('first')?.sendQueue).toBeDefined()
})

it.each(['user-stop', 'start-failed'])('does not bypass Life hold %s with a completed native record', async hold => {
  remote.life.mockResolvedValue({ kind: 'ready', hold })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.life).toHaveBeenCalled())
  await settle()
  expect(remote.history).not.toHaveBeenCalled()
  expect(delivered).not.toHaveBeenCalled()
})

it('keeps a failed durable writer blocked instead of using an older successful native turn', async () => {
  remote.history.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  remote.history.mockResolvedValue({ ok: true, value: record([turn('old-native', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'current-source', status: 'failed', cause: { message: 'disk unavailable' } } as never)
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(2))
  await settle()
  expect(delivered).not.toHaveBeenCalled()
})

it('only clears a failed write after a successful receipt for that same reference', async () => {
  remote.history.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  remote.history.mockResolvedValue({ ok: true, value: record([turn('old-native', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'current-source', status: 'failed', cause: { message: 'disk unavailable' } } as never)
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(2))
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'old-source', status: 'persisted' } as never)
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(3))
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  expect(read('first')?.sendQueue).toBeDefined()
  remote.history.mockResolvedValue({ ok: true, value: record([turn('current-native', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'current-source', status: 'persisted' } as never)
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it('retains other failed references when one write is successfully retried', async () => {
  remote.history.mockResolvedValue({ ok: true, value: record([], turn('current-native')) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  for (const [index, referenceId] of ['first-failed', 'second-failed'].entries()) {
    remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId, status: 'failed', cause: { message: 'disk unavailable' } } as never)
    await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(index + 2))
  }
  remote.history.mockResolvedValue({ ok: true, value: record([turn('first-retried', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'first-failed', status: 'persisted' } as never)
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(4))
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  remote.history.mockResolvedValue({ ok: true, value: record([turn('second-retried', { kind: 'done' })]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'second-failed', status: 'persisted' } as never)
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it.each(['disconnect', 'account-change', 'dispose'] as const)('ignores a late completed native read after %s', async reason => {
  const pending = Promise.withResolvers<unknown>()
  remote.history.mockReturnValueOnce(pending.promise)
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  if (reason === 'disconnect') remote.link(false)
  else if (reason === 'account-change') { state().valid = () => false; changed() }
  else stop()
  pending.resolve({ ok: true, value: record([turn('completed', { kind: 'done' })]) })
  await pending.promise; await Promise.resolve(); await settle()
  expect(delivered).not.toHaveBeenCalled()
  expect(read('first')?.sendQueue).toBeDefined()
})

it('requires a completed predecessor identity even when a different input has identical text', async () => {
  await installed.outbox.edit('first', { ...first, sendQueue: { order: 1, afterInputId: 'expected-client' } })
  const completed = (clientMessageId: string): TranscriptTurn => ({ ...turn('stored', { kind: 'done' }), items: [
    { kind: 'message', role: 'user', seq: 0, id: 'provider-user', text: 'same', _meta: { guguClientMessageId: clientMessageId } },
  ] })
  remote.history.mockResolvedValue({ ok: true, value: record([completed('different-client')]) })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  remote.history.mockResolvedValue({ ok: true, value: record([completed('expected-client')]) })
  remote.events.get('session:turn-settled')!({ sessionId: 'session', referenceId: 'expected-source', status: 'persisted' } as never)
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
  expect(delivered.mock.calls[0][0].id).toBe('first')
})

it('does not release when the timeline cannot be read', async () => {
  remote.history.mockResolvedValue({ ok: false, error: { code: 'record_not_found', message: 'Native record unavailable' } })
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.report).toHaveBeenCalled())
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  expect(read('first')?.sendQueue).toBeDefined()
})

it('waits for the directory to identify the target before interpreting its history', async () => {
  remote.runtime = null
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.snapshot).toHaveBeenCalled())
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  remote.runtime = 'acp'; remote.directoryChanged()
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it('releases for a terminal-hosted target from the same timeline', async () => {
  remote.runtime = 'pty'
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it('rechecks when the last live reply clears after native persistence, without a provider turn patch', async () => {
  const base: TimelineSnapshot = { cursor: { epoch: 'provider', seq: 1 }, turns: [turn('unsettled-provider')],
    queuedPrompts: [], settlements: [], liveReply: { sourceMessageId: 'message', activity: { phase: 'replying' } }, hasOlder: false }
  remote.base = base
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  expect(delivered).not.toHaveBeenCalled()
  remote.base = { ...base, liveReply: null }
  remote.timeline({ ok: true, batch: { from: 1, cursor: { epoch: 'provider', seq: 2 }, turns: [],
    removedTurnIds: [], settlements: [], queuedPrompts: [], liveReply: null } })
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it.each(['resolved', 'cancelled'] as const)('rechecks a completed native foreground when its last settlement is %s', async state => {
  const pending = { itemId: 'approval', state: 'pending' as const, optionId: null, resolvedBy: null, resolvedAt: null }
  const base: TimelineSnapshot = { cursor: { epoch: 'provider', seq: 1 }, turns: [turn('unsettled-provider')],
    queuedPrompts: [], settlements: [pending], liveReply: null, hasOlder: false }
  remote.base = base
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  const settled = { ...pending, state }
  remote.base = { ...base, settlements: [settled] }
  remote.timeline({ ok: true, batch: { from: 1, cursor: { epoch: 'provider', seq: 2 }, turns: [],
    removedTurnIds: [], settlements: [settled], queuedPrompts: [], liveReply: null } })
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})

it('retains the queue when another settlement is still pending', async () => {
  const first = { itemId: 'first-approval', state: 'pending' as const, optionId: null, resolvedBy: null, resolvedAt: null }
  const second = { ...first, itemId: 'second-approval' }
  const base: TimelineSnapshot = { cursor: { epoch: 'provider', seq: 1 }, turns: [turn('unsettled-provider')],
    queuedPrompts: [], settlements: [first, second], liveReply: null, hasOlder: false }
  remote.base = base
  stop = watchPhoneSessionSendQueues('owner')
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(1))
  const settledFirst = { ...first, state: 'resolved' as const }
  remote.base = { ...base, settlements: [settledFirst, second] }
  remote.timeline({ ok: true, batch: { from: 1, cursor: { epoch: 'provider', seq: 2 }, turns: [],
    removedTurnIds: [], settlements: [settledFirst], queuedPrompts: [], liveReply: null } })
  await vi.waitFor(() => expect(remote.history).toHaveBeenCalledTimes(2))
  await settle()
  expect(delivered).not.toHaveBeenCalled()
  const settledSecond = { ...second, state: 'cancelled' as const }
  remote.base = { ...base, settlements: [settledFirst, settledSecond] }
  remote.timeline({ ok: true, batch: { from: 2, cursor: { epoch: 'provider', seq: 3 }, turns: [],
    removedTurnIds: [], settlements: [settledSecond], queuedPrompts: [], liveReply: null } })
  await vi.waitFor(() => expect(delivered).toHaveBeenCalledTimes(1))
})
