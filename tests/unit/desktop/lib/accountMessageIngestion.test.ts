import { afterEach, expect, it, vi } from 'vitest'
import { message, deferred, displayIdentity } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { confirmSentMessage, imSelectors, openImRepository, type OutboxRecord } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator, type AccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { AccountRevisionOperation } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { ingestMessages, readMessagePage } from '../../../../apps/desktop/src/lib/messageIngest'
import { clearMessageWindows, initializeMessageWindows, messageWindow, publishMessageWindows, setMessageWindow } from '../../../../apps/desktop/src/lib/messageWindows'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { bindRepositoryMessageCache } from '../../../../apps/desktop/src/store/chatDiskWindow'
import { serializeComposerCard, type QuestionCard } from '../../../../packages/core/src/shared/ui/taskCardModels'
import { messageRevisionWrites } from '../../../../apps/desktop/src/lib/messageRevisionWrites'

// Account revisions reach the one message store (here its IndexedDB adapter, as on the phone; the desktop runs the same
// contract over SQLite, see im-messages/contract.db.test.ts). The store reports first arrivals; the renderer keeps no claims.
const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); clearMessageWindows('viewer'); vi.useRealTimers() })
const row = (id: string, seq = 1) => message({ id, seq, chat_id: 'room', sender_user_id: 'peer', to_user_ids: ['viewer'] })
const arrival = (revision: string, id: string, body: unknown = row(id)): AccountRevisionOperation => ({
  revision, event: 'message_created', payload: { chat_id: 'room', entity_id: id, message: body },
})
const membership = (revision: string, left: boolean, userId = 'viewer'): AccountRevisionOperation => ({
  revision, event: 'chat_members_changed', payload: { chat_id: 'room', user_id: userId, kind: 'roster', tombstone: left },
})
const stored = () => messageWindow('viewer', 'room')?.map(item => item.id)

async function rig(initial: AccountRevisionOperation[] = [], recover = vi.fn(async (_id: string) => null as ReturnType<typeof message> | null)) {
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  const cache = new ChatWindowCache('viewer')
  stops.push(bindRepositoryMessageCache(repository, cache))
  const operations = [...initial]
  let wake!: (head?: string | null) => void
  const notify = vi.fn(async (_item: ReturnType<typeof message>) => {})
  const coordinator: AccountRevisionCoordinator = createAccountRevisionCoordinator('viewer', repository, {
    syncSince: async cursor => ({ operations: operations.filter(op => BigInt(op.revision) > BigInt(cursor)), hasMore: false }),
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }, { recover, notify })
  stops.push(() => { coordinator.stop(); repository.close() })
  coordinator.start()
  await coordinator.whenIdle()
  return { repository, coordinator, cache, notify, recover,
    send(...next: AccountRevisionOperation[]) { operations.push(...next); wake(next.at(-1)!.revision); return coordinator.whenIdle() },
  }
}

it('commits live arrivals only to the message store, feeds the unopened conversation and notifies once', async () => {
  const r = await rig()
  await r.send(arrival('1', 'live', row('live', 7)))
  expect(stored()).toEqual(['live'])
  expect(r.repository.snapshot().view.filter(view => view.key.startsWith('message-'))).toEqual([])
  expect(r.cache.get('room')?.map(item => item.id)).toEqual(['live'])
  expect(r.notify.mock.calls.map(([item]) => item.id)).toEqual(['live'])
  await r.send(arrival('2', 'live', row('live', 7)))
  expect(r.notify).toHaveBeenCalledTimes(1)
})

it('silently ingests baseline history, then notifies only new live ids even when a page stored the body first', async () => {
  const r = await rig([arrival('1', 'baseline')])
  expect(stored()).toEqual(['baseline'])
  expect(r.notify).not.toHaveBeenCalled()
  await r.send(arrival('2', 'baseline'))
  expect(r.notify).not.toHaveBeenCalled()
  // An open conversation that is not on screen can fetch the message before the account feed delivers it.
  await ingestMessages('viewer', { writes: [{ type: 'put', message: row('live', 2) }], revisions: [] })
  await r.send(arrival('3', 'live', row('live', 2)))
  expect(r.notify.mock.calls.map(([item]) => item.id)).toEqual(['live'])
})

it('reports each of many first arrivals once and none on a repeat', async () => {
  const r = await rig()
  await r.send(...Array.from({ length: 30 }, (_, index) => arrival(String(index + 1), `m${index}`, row(`m${index}`, index + 1))))
  expect(r.notify).toHaveBeenCalledTimes(30)
  await r.send(arrival('31', 'm0', row('m0', 1)))
  expect(r.notify).toHaveBeenCalledTimes(30)
})

it('keeps a missing payload in the existing inbox until recovery returns its body', async () => {
  const body = deferred<ReturnType<typeof message> | null>()
  const r = await rig([], vi.fn(() => body.promise))
  const done = r.send(arrival('1', 'legacy', null))
  await vi.waitFor(() => expect(r.recover).toHaveBeenCalledWith('legacy'))
  expect(r.repository.snapshot().view.some(view => view.key === 'account-revision-operation:1')).toBe(true)
  expect(r.notify).not.toHaveBeenCalled()
  body.resolve(row('legacy'))
  await done
  expect(r.notify).toHaveBeenCalledTimes(1)
  expect(r.repository.snapshot().view.some(view => view.key === 'account-revision-operation:1')).toBe(false)
})

it('recovers an older payload without recipient metadata instead of silently consuming its notification', async () => {
  const authoritative = row('old-payload')
  const r = await rig([], vi.fn(async () => authoritative))
  const { to_user_ids: _missing, ...oldPayload } = authoritative
  await r.send(arrival('1', authoritative.id, oldPayload))
  expect(r.recover).toHaveBeenCalledWith(authoritative.id)
  expect(r.notify).toHaveBeenCalledWith(authoritative)
})

it('isolates failed payload recovery from another consumer and retries it', async () => {
  vi.useFakeTimers()
  const recover = vi.fn(async () => row('legacy')).mockRejectedValueOnce(new Error('body unavailable'))
  const r = await rig([], recover)
  const unrelated = vi.fn()
  r.coordinator.subscribe('chat_changed', unrelated)
  await expect(r.send(arrival('1', 'legacy', null), { revision: '2', event: 'chat_changed', payload: { chat_id: 'room' } })).rejects.toThrow('body unavailable')
  expect(unrelated).toHaveBeenCalledTimes(1)
  expect(r.notify).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(1000)
  await r.coordinator.whenIdle()
  expect(r.notify).toHaveBeenCalledTimes(1)
  expect(unrelated).toHaveBeenCalledTimes(1)
})

it('does not notify or revive an arrival deleted in the same page, nor when a stale page or create completes later', async () => {
  const r = await rig()
  await r.send(arrival('1', 'removed'), { revision: '2', event: 'message_deleted', payload: { chat_id: 'room', entity_id: 'removed' } },
    arrival('3', 'removed'))
  expect(r.notify).not.toHaveBeenCalled()
  await ingestMessages('viewer', { writes: [{ type: 'put', message: row('removed') }], revisions: [] })
  await r.send(arrival('4', 'removed'))
  expect(stored() ?? []).toEqual([])
  expect(r.cache.rows('room')).toEqual([])
  expect(r.notify).not.toHaveBeenCalled()
})

it('authoritative recovery absence cannot materialize or notify an inaccessible message', async () => {
  const r = await rig()
  await r.send(arrival('1', 'inaccessible', null))
  expect(r.recover).toHaveBeenCalledWith('inaccessible')
  expect(stored() ?? []).toEqual([])
  expect(r.notify).not.toHaveBeenCalled()
})

it('does not retry an alert after a committed claim even when the notification outlet fails', async () => {
  const r = await rig()
  r.notify.mockRejectedValueOnce(new Error('notification transport unavailable'))
  await r.send(arrival('1', 'claimed'))
  await r.send(arrival('2', 'claimed'))
  r.coordinator.retryPending(); await r.coordinator.whenIdle()
  expect(r.notify).toHaveBeenCalledTimes(1)
  await r.send(arrival('3', 'another', row('another', 2)))
  expect(r.notify).toHaveBeenCalledTimes(2)
})

it('keeps the stored tail verified through a revision batch whose sequence skips numbers', async () => {
  const r = await rig()
  await r.send(...Array.from({ length: 30 }, (_, index) => arrival(String(index + 1), `m${index + 1}`, row(`m${index + 1}`, 2 * index + 50))))
  // Cold open asks whether the stored tail is contiguous up to its own newest row (seq 108).
  const page = await readMessagePage('viewer', { chatId: 'room', beforeSeq: 109, limit: 30 })
  expect(page.rows).toHaveLength(30)
  expect(page.covered).toBe(true)
})

it('membership rejoin permits a new body and notification after the revoked interval', async () => {
  const r = await rig()
  await r.send(membership('1', true), membership('2', false))
  await r.send(arrival('3', 'after-rejoin'))
  expect(stored()).toEqual(['after-rejoin'])
  expect(r.notify.mock.calls.map(([item]) => item.id)).toEqual(['after-rejoin'])
})

it('membership changes for another member do not revoke this account or suppress its messages', async () => {
  const r = await rig()
  await r.send(membership('1', true, 'peer'), arrival('2', 'still-authorized'))
  expect(stored()).toEqual(['still-authorized'])
  expect(r.notify.mock.calls.map(([item]) => item.id)).toEqual(['still-authorized'])
})

it('writes a confirmed send into the message store', async () => {
  const r = await rig()
  const sent = row('sent', 3)
  await confirmSentMessage(r.repository, { clientMessageId: 'sent' } as OutboxRecord, sent)
  expect(stored()).toEqual(['sent'])
})

it('updates the original phone card, preserves it through stale window reads, and never notifies another arrival', async () => {
  const card: QuestionCard = { v: 1, type: 'question', text: 'Choose', options: ['Yes'], ownerUserId: 'peer',
    questionId: 'agent-question:card', sessionId: 'session', projectId: 'project', deviceId: 'device', machineLabel: 'Mac' }
  const before = { ...row('card'), content_type: 'card' as const, content: serializeComposerCard(card) }
  const after = { ...before, content: serializeComposerCard({ ...card, settled: { state: 'answered', at: 'now', answers: [{ selected: ['Yes'] }] } }) }
  const r = await rig([arrival('1', 'card', before)])
  r.coordinator.subscribe('chat_changed', vi.fn())
  const refresh: AccountRevisionOperation = { revision: '2', event: 'chat_changed', payload: { chat_id: 'room', message_id: 'card', message: after } }
  await r.send(refresh)
  expect(messageWindow('viewer', 'room')).toMatchObject([{ id: 'card', seq: 1, content: after.content }])
  expect(r.cache.rows('room')).toMatchObject([{ id: 'card', content: after.content }])
  // A page requested before the settlement committed lands later: the store's merge keeps the settled card.
  await ingestMessages('viewer', { writes: [{ type: 'put', message: before }], revisions: [] })
  expect(messageWindow('viewer', 'room')![0]!.content).toBe(after.content)
  expect(r.notify).not.toHaveBeenCalled()
  expect(r.recover).not.toHaveBeenCalled()
  expect(messageRevisionWrites('viewer', [refresh], '2').revisions).toMatchObject([{ revision: '2', writes: [{ type: 'put', message: { id: 'card', content: after.content } }] }])
})

it('removes an inaccessible refreshed body and rejects a refresh crossing the chat boundary', async () => {
  const r = await rig([arrival('1', 'card')])
  r.coordinator.subscribe('chat_changed', vi.fn())
  const missing: AccountRevisionOperation = { revision: '2', event: 'chat_changed', payload: { chat_id: 'room', message_id: 'card', message: null } }
  await r.send(missing)
  expect(stored() ?? []).toEqual([])
  expect(messageRevisionWrites('viewer', [missing], '2').revisions).toMatchObject([{ writes: [{ type: 'delete', chatId: 'room', id: 'card' }] }])
  expect(() => messageRevisionWrites('viewer', [{ ...missing, payload: { chat_id: 'wrong-room', message_id: 'card', message: row('card') } }], '2')).toThrow('malformed message')
  expect(r.notify).not.toHaveBeenCalled()
})

it('a store re-read of unchanged rows keeps the published rows and does not publish again', () => {
  initializeMessageWindows('viewer')
  const publish = vi.fn()
  publishMessageWindows('viewer', publish)
  const first = row('kept', 1)
  setMessageWindow('viewer', 'room', null, [first])
  setMessageWindow('viewer', 'room', null, [{ ...first }])
  expect(publish).toHaveBeenCalledTimes(1)
  expect(messageWindow('viewer', 'room')![0]).toBe(first)
  setMessageWindow('viewer', 'room', null, [{ ...first, content: 'edited' }])
  expect(publish).toHaveBeenCalledTimes(2)
})

// @@@selected-change: a write to other tables (every message write touches cursors and views) must not call an identities
// subscriber again with the same map. The chat store feeds it to a React setter, which keeps every same-value call queued
// until the provider renders again.
it('calls a repository subscriber again only when what it selected changed', async () => {
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  const seen: string[][] = []
  repository.subscribe(imSelectors.identitiesById, (identities) => seen.push(Object.keys(identities)))
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '1' }))
  await repository.transaction(tx => tx.putView('active-chat', 'room'))
  await repository.transaction(tx => tx.putIdentity(displayIdentity('peer')))
  await repository.transaction(tx => tx.putIdentity(displayIdentity('peer')))
  expect(seen).toEqual([[], ['peer']])
})
