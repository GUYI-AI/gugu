import { afterEach, expect, it, vi } from 'vitest'
import { message } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { imSelectors, openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { createAccountRevisionCoordinator } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import { parseRevisionPage, validatePage, type AccountRevisionOperation, type AccountRevisionPage } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { ingestMessagePage, readMessagePage } from '../../../../apps/desktop/src/lib/messageIngest'
import { clearMessageWindows, initializeMessageWindows } from '../../../../apps/desktop/src/lib/messageWindows'

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); clearMessageWindows('viewer') })
const arrival = (revision: string, id: string, seq: number): AccountRevisionOperation => ({
  revision, event: 'message_created',
  payload: { chat_id: 'room', entity_id: id, message: message({ id, seq, chat_id: 'room', sender_user_id: 'peer', to_user_ids: ['viewer'] }) },
})

it('reads an ordinary page as consecutive and a compacted page as increasing inside its window', () => {
  const page = (revisions: string[], through?: string): AccountRevisionPage =>
    ({ operations: revisions.map(revision => ({ revision, event: 'chat_changed', payload: {} })), hasMore: false, ...(through ? { through } : {}) })
  expect(() => validatePage(page(['6', '7']), '5')).not.toThrow()
  expect(() => validatePage(page(['6', '9']), '5')).toThrow('sequence is invalid at 9')
  expect(() => validatePage(page(['6', '9', '40'], '50'), '5')).not.toThrow()
  expect(() => validatePage(page([], '50'), '5')).not.toThrow()
  expect(() => validatePage(page(['9', '6'], '50'), '5')).toThrow('sequence is invalid at 6')
  expect(() => validatePage(page(['6', '60'], '50'), '5')).toThrow('sequence is invalid at 60')
  expect(() => validatePage(page([], '5'), '5')).toThrow('window ends at 5')
  expect(parseRevisionPage({ operations: [], has_more: true, compacted: true, through_revision: '50' })).toEqual({ operations: [], hasMore: true, through: '50' })
  expect(() => parseRevisionPage({ operations: [], has_more: true, compacted: true })).toThrow('without its window')
})

it('asks for the compacted read, takes its window as the cursor, voids a stream at its gap and recovers nothing', async () => {
  initializeMessageWindows('viewer')
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  const recover = vi.fn(async () => null)
  let wake!: (head?: string | null) => void
  const pages: Record<string, AccountRevisionPage> = {
    0: { operations: [arrival('1', 'held-1', 1), arrival('2', 'held-2', 2)], hasMore: false },
    2: { operations: [{ revision: '700', event: 'message_created', payload: { chat_id: 'room', entity_id: 'newest', gap: true, tombstone: false } },
      { revision: '880', event: 'chat_changed', payload: { chat_id: 'room', tombstone: false } }], hasMore: false, through: '900' },
    900: { operations: [arrival('901', 'after-gap', 480)], hasMore: false },
  }
  const asked: unknown[] = []
  const coordinator = createAccountRevisionCoordinator('viewer', repository, {
    syncSince: async (cursor, limit, _signal, compact) => { asked.push([cursor, limit, compact]); return pages[cursor] ?? { operations: [], hasMore: false } },
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }, { recover, notify: vi.fn(async () => {}) })
  stops.push(() => { coordinator.stop(); repository.close() })
  coordinator.start()
  await coordinator.whenIdle()
  expect(asked[0]).toEqual(['0', 500, true])
  expect((await readMessagePage('viewer', { chatId: 'room', beforeSeq: 3, limit: 2 })).covered).toBe(true)
  wake('900'); await coordinator.whenIdle()
  expect((imSelectors.syncState('account-revision-cursor')(repository.snapshot()) as { revision: string }).revision).toBe('900')
  expect((await readMessagePage('viewer', { chatId: 'room', beforeSeq: 3, limit: 2 })).covered).toBe(false)
  expect(recover).not.toHaveBeenCalled()
  // An arrival after the gap starts a new range: it does not bridge back to the rows held before it.
  wake('901'); await coordinator.whenIdle()
  expect((await readMessagePage('viewer', { chatId: 'room', beforeSeq: 481, limit: 3 })).rows.map(row => row.id)).toEqual(['held-1', 'held-2', 'after-gap'])
  expect((await readMessagePage('viewer', { chatId: 'room', beforeSeq: 481, limit: 3 })).covered).toBe(false)
})

// A collapsed chat still delivers each deletion (the backend keeps message_deleted out of the collapse).
it('removes deleted rows it holds when their chat arrives collapsed, and refuses them from a later page', async () => {
  initializeMessageWindows('viewer')
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  await repository.transaction(tx => tx.putSyncState('account-revision-cursor', { revision: '0' }))
  let wake!: (head?: string | null) => void
  const deleted = (revision: string, id: string): AccountRevisionOperation =>
    ({ revision, event: 'message_deleted', payload: { chat_id: 'room', entity_id: id, tombstone: true } })
  const pages: Record<string, AccountRevisionPage> = {
    0: { operations: [arrival('1', 'held-1', 1), arrival('2', 'held-2', 2), arrival('3', 'held-3', 3)], hasMore: false },
    // Away: 'middle' and 'newest' arrived and were deleted, and so was held-2. The marker names the deleted newest message.
    3: { operations: [{ revision: '700', event: 'message_created', payload: { chat_id: 'room', entity_id: 'newest', gap: true, tombstone: false } },
      deleted('710', 'held-2'), deleted('720', 'middle'), deleted('730', 'newest')], hasMore: false, through: '900' },
  }
  const recover = vi.fn(async () => null)
  const coordinator = createAccountRevisionCoordinator('viewer', repository, {
    syncSince: async cursor => pages[cursor] ?? { operations: [], hasMore: false },
    subscribeWake: (_account, onWake) => { wake = onWake; return () => undefined },
  }, { recover, notify: vi.fn(async () => {}) })
  stops.push(() => { coordinator.stop(); repository.close() })
  coordinator.start()
  await coordinator.whenIdle()
  wake('900'); await coordinator.whenIdle()
  const stored = async () => (await readMessagePage('viewer', { chatId: 'room', limit: 50 })).rows.map(row => row.id)
  expect(await stored()).toEqual(['held-1', 'held-3'])
  expect(recover).not.toHaveBeenCalled()
  // Scrolling up reads a server page; a row the journal deleted cannot come back with it.
  const row = (id: string, seq: number) => message({ id, seq, chat_id: 'room', sender_user_id: 'peer', to_user_ids: ['viewer'] })
  await ingestMessagePage('viewer', [row('held-1', 1), row('held-2', 2), row('held-3', 3), row('middle', 40), row('newest', 90)], 'room', 60)
  expect(await stored()).toEqual(['held-1', 'held-3'])
})
