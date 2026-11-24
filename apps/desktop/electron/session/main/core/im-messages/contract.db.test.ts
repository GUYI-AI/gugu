import 'fake-indexeddb/auto'
import { IDBFactory } from 'fake-indexeddb'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openFixture, type FixtureDb } from '@tooling/utils/db'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ImMessageBatch, ImMessagePage, ImMessageWrite } from '@shared/core/im-messages'
import { createImMessageStore } from './store'
import { createLocalMessageStore } from '../../../../../src/lib/localMessageStore'

vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }))

// @@@client-state-model - one storage contract, two adapters. Every case runs against the desktop's session SQLite and the
// phone's IndexedDB store; a behaviour that differs between them is a failing case, not a platform note.

type Store = {
  ingest(accountId: string, batch: ImMessageBatch): Promise<ImMessageWrite[]>
  windows(accountId: string, chatIds: string[], limit: number): Promise<MessageItem[]>
  page(accountId: string, page: ImMessagePage): Promise<{ rows: MessageItem[]; covered: boolean }>
  throughRevision(accountId: string): Promise<string | null>
  clearAccount(accountId: string): Promise<void>
}
type Rig = { store: Store; reopen(): Store; close(): void }

const subjects: [string, () => Promise<Rig>][] = [
  ['sqlite', async () => {
    const fixture: FixtureDb = await openFixture('empty')
    const wrap = (store: ReturnType<typeof createImMessageStore>): Store => ({
      ingest: async (...args) => store.ingest(...args),
      windows: async (...args) => store.windows(...args),
      page: async (...args) => store.page(...args),
      throughRevision: async (...args) => store.throughRevision(...args),
      clearAccount: async (...args) => store.clearAccount(...args),
    })
    return { store: wrap(createImMessageStore(fixture.sqlite)), reopen: () => wrap(createImMessageStore(fixture.sqlite)), close: () => fixture.close() }
  }],
  ['indexeddb', async () => {
    const indexedDb = new IDBFactory()
    const opened: { close(): void }[] = []
    const open = () => { const store = createLocalMessageStore({ indexedDb }); opened.push(store); return store }
    return { store: open(), reopen: open, close: () => { for (const store of opened) store.close() } }
  }],
]

const account = 'account-a'
const message = (id: string, content = 'orchid original', seq = 1, over: Partial<MessageItem> = {}) => {
  const row = {
    ...messageItemFromRow({ id, chat_id: 'chat-a', seq, content, content_type: 'text',
      sender_user_id: account, created_at: '2026-11-02T00:00:00Z', thread_root_id: null }, account)!, ...over,
  }
  delete row.local_send_state
  return row
}
const batch = (...messages: MessageItem[]): ImMessageBatch => ({ writes: messages.map(message => ({ type: 'put', message })), revisions: [] })
const ids = (rows: MessageItem[]) => rows.map(row => row.id)

describe.each(subjects)('IM message store contract (%s)', (_name, open) => {
  let rig: Rig
  let store: Store
  const setup = async () => { rig = await open(); store = rig.store }
  afterEach(() => rig?.close())

  it('keeps receipts monotonic when a page re-reads a body without them', async () => {
    await setup()
    await store.ingest(account, batch(message('one', 'orchid', 1, { delivered: true, delivery_status: 'read', readers: ['agent-a'] })))
    await store.ingest(account, batch(message('one', 'orchid revised')))
    const [row] = await store.windows(account, ['chat-a'], 1)
    expect(row).toMatchObject({ content: 'orchid revised', delivered: true, delivery_status: 'read', readers: ['agent-a'] })
  })

  it('applies an overlay patch to the stored row only, merged by the same rules', async () => {
    await setup()
    await store.ingest(account, batch(message('one', 'orchid', 1, { readers: ['agent-a'] })))
    await store.ingest(account, batch(message('one', 'orchid edited')))
    await store.ingest(account, { writes: [
      { type: 'patch', chatId: 'chat-a', id: 'one', fields: { readers: ['agent-b'], delivered: true, reactions: [{ emoji: '👍', count: 1, my_reaction: true }] } },
      { type: 'patch', chatId: 'chat-a', id: 'absent', fields: { delivered: true } },
    ], revisions: [] })
    const [row] = await store.windows(account, ['chat-a'], 5)
    expect(row).toMatchObject({ content: 'orchid edited', delivered: true, reactions: [{ emoji: '👍', count: 1, my_reaction: true }] })
    expect(row!.readers?.sort()).toEqual(['agent-a', 'agent-b'])
    expect(await store.windows(account, ['chat-a'], 5)).toHaveLength(1)
  })

  it('keeps stored reactions and refusals when a body-only row rewrites the message; an explicit overlay replaces them', async () => {
    await setup()
    const reactions = [{ emoji: '👍', count: 1, my_reaction: true }]
    const blocks = [{ agent_user_id: 'agent-a', reason: 'agent_archived' as const }]
    await store.ingest(account, batch(message('one', 'orchid original', 1, { reactions, delivery_blocks: blocks })))
    await store.ingest(account, batch(message('one', 'violet revised')))
    expect((await store.windows(account, ['chat-a'], 1))[0]).toMatchObject({ content: 'violet revised', reactions, delivery_blocks: blocks })
    await store.ingest(account, batch(message('one', 'violet revised', 1, { reactions: [], delivery_blocks: [] })))
    expect((await store.windows(account, ['chat-a'], 1))[0]).toMatchObject({ reactions: [], delivery_blocks: [] })
  })

  it('drops a send-time position an older build stored on a confirmed row once the server body arrives', async () => {
    await setup()
    const local_timeline = { afterSeq: 4, createdAt: '2026-11-02T00:00:00Z' }
    await store.ingest(account, batch(message('resent', 'first', 8, { local_timeline })))
    await store.ingest(account, batch(message('resent', 'refreshed', 8, { reactions: [], delivery_blocks: [] })))
    expect((await store.windows(account, ['chat-a'], 10))[0]).not.toHaveProperty('local_timeline')
  })

  it('keeps the main tail covered through revision arrivals whose sequence skips numbers thread replies took', async () => {
    await setup()
    await store.ingest(account, { ...batch(message('m1', 'a', 1), message('m2', 'b', 2)), ranges: [{ chatId: 'chat-a', fromSeq: 1, toSeq: 2 }] })
    await store.ingest(account, { writes: [], revisions: [
      { revision: '1', writes: [{ type: 'put', message: message('r3', 'reply', 3, { thread_root_id: 'm1' }) }] },
      { revision: '2', writes: [{ type: 'put', message: message('m4', 'c', 4) }] },
    ], throughRevision: '2' })
    // A page is covered only up to the cursor it names: the local tail alone never proves nothing newer exists.
    const tail = await store.page(account, { chatId: 'chat-a', beforeSeq: 5, limit: 3 })
    expect(ids(tail.rows)).toEqual(['m1', 'm2', 'm4'])
    expect(tail.covered).toBe(true)
    // A body without a revision (an outbound acknowledgement) is stored, but proves nothing about the numbers before it.
    await store.ingest(account, batch(message('m9', 'ack', 9)))
    expect((await store.page(account, { chatId: 'chat-a', beforeSeq: 10, limit: 4 })).covered).toBe(false)
  })

  it('commits deletion and progress together, rejects late writes, and skips already consumed revision writes', async () => {
    await setup()
    await store.ingest(account, { ...batch(message('one')), throughRevision: '1' })
    await store.ingest(account, { writes: [], revisions: [{ revision: '2', writes: [{ type: 'delete', chatId: 'chat-a', id: 'one' }] }], throughRevision: '2' })
    expect(await store.throughRevision(account)).toBe('2')
    expect(await store.windows(account, ['chat-a'], 10)).toEqual([])
    await store.ingest(account, batch(message('one', 'late network response')))
    await store.ingest(account, { writes: [], revisions: [{ revision: '1', writes: [{ type: 'put', message: message('one') }] }], throughRevision: '1' })
    expect(await store.windows(account, ['chat-a'], 10)).toEqual([])
    expect(await store.throughRevision(account)).toBe('2')
    expect(await rig.reopen().throughRevision(account)).toBe('2')
  })

  it('rolls back rows and progress when a page fails, on disk and in what the next read sees', async () => {
    await setup()
    await store.ingest(account, { ...batch(message('one')), throughRevision: '1' })
    await expect(store.ingest(account, { writes: [], revisions: [
      { revision: '2', writes: [{ type: 'put', message: message('one', 'violet revised') }] },
      { revision: '3', writes: [{ type: 'put', message: { ...message('invalid-sequence'), seq: Number.NaN } }] },
    ], throughRevision: '3' })).rejects.toThrow('Invalid message sequence')
    for (const reader of [store, rig.reopen()]) {
      expect((await reader.windows(account, ['chat-a'], 10)).map(row => row.content)).toEqual(['orchid original'])
      expect(await reader.throughRevision(account)).toBe('1')
    }
  })

  it('ignores optimistic sequences, removes local preview fields and claims a message on its first revision only', async () => {
    await setup()
    expect(await store.ingest(account, batch({ ...message('optimistic'), seq: -1 }))).toEqual([])
    const row = message('confirmed')
    const accepted = await store.ingest(account, batch({ ...row, local_send_state: 'sending', image_dimensions: { width: 10, height: 20 } }))
    expect(accepted, 'a page fetch stores the body without claiming it').toEqual([{ type: 'put', message: row }])
    const page = (revision: string, message: MessageItem): ImMessageBatch => ({ writes: [], revisions: [{ revision, writes: [{ type: 'put', message }] }] })
    expect(await store.ingest(account, page('1', row)), 'its first revision claims it').toEqual([{ type: 'put', message: row, claimed: true }])
    expect(await store.ingest(account, page('2', row)), 'a later revision of a claimed message does not').toEqual([{ type: 'put', message: row }])
    expect(await store.ingest(account, batch(row)), 'a later fetch keeps the claim').toEqual([{ type: 'put', message: row }])
    expect(await rig.reopen().ingest(account, page('3', row)), 'the claim is durable').toEqual([{ type: 'put', message: row }])
  })

  it('isolates overlapping message IDs across accounts and clears only an explicitly logged out account', async () => {
    await setup()
    await store.ingest(account, { ...batch(message('same')), throughRevision: '2' })
    await store.ingest('account-b', { ...batch(message('same', 'zinnia private')), throughRevision: '3' })
    await store.clearAccount(account)
    for (const reader of [store, rig.reopen()]) {
      expect(await reader.throughRevision(account)).toBe(null)
      expect(await reader.throughRevision('account-b')).toBe('3')
      expect(await reader.windows(account, ['chat-a'], 40)).toEqual([])
      expect((await reader.windows('account-b', ['chat-a'], 40))[0]?.content).toBe('zinnia private')
    }
  })

  it('removes an authoritative departed chat and blocks a late page until the chat is authoritatively restored', async () => {
    await setup()
    await store.ingest(account, batch(message('one'), message('other', 'violet retained', 1, { chat_id: 'chat-b' })))
    await store.ingest(account, { writes: [{ type: 'deleteChat', chatId: 'chat-a' }], revisions: [] })
    await store.ingest(account, batch(message('late')))
    expect((await store.page(account, { chatId: 'chat-a', limit: 40 })).rows).toEqual([])
    expect(ids((await store.page(account, { chatId: 'chat-b', limit: 40 })).rows)).toEqual(['other'])
    await store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'chat-a', ownMember: true } }, { type: 'put', message: message('new') }], revisions: [] })
    expect(ids((await store.page(account, { chatId: 'chat-a', limit: 40 })).rows)).toEqual(['new'])
  })

  it('loads only bounded main windows and paginates more than fifty stored thread replies without skipping the root', async () => {
    await setup()
    const rows = Array.from({ length: 180 }, (_, i) => message(`main-${i + 1}`, 'main', i + 1))
    rows.push(message('root', 'topic root', 181, { is_thread_root: true }))
    rows.push(...Array.from({ length: 130 }, (_, i) => message(`reply-${i + 1}`, 'reply', i + 182, { thread_root_id: 'root' })))
    await store.ingest(account, batch(...rows))
    const windows = await store.windows(account, ['chat-a'], 40)
    expect(windows).toHaveLength(40)
    expect(windows[0]?.seq).toBe(142)
    expect(windows.at(-1)?.id).toBe('root')
    const all: MessageItem[] = []
    let beforeSeq: number | undefined
    for (;;) {
      const page = (await store.page(account, { chatId: 'chat-a', threadRootId: 'root', beforeSeq, limit: 50 })).rows
      if (page.length === 0) break
      all.push(...page)
      beforeSeq = page[0]!.seq
    }
    expect(new Set(ids(all)).size).toBe(131)
    expect(all.filter(row => row.id === 'root')).toHaveLength(1)
  })

  it('reads canonical rows by id, across chats and after a restart', async () => {
    await setup()
    await store.ingest(account, batch(message('a1', 'x', 2), message('b1', 'y', 1, { chat_id: 'chat-b' })))
    for (const reader of [store, rig.reopen()]) {
      const page = await reader.page(account, { ids: ['b1', 'a1', 'missing'], limit: 64 })
      expect(ids(page.rows)).toEqual(['b1', 'a1'])
      expect(page.covered).toBe(false)
    }
  })

  it('d5: deletes inherited topic histories after a source departure while preserving topics with their own membership', async () => {
    await setup()
    await store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'source', ownMember: true } },
      { type: 'chatAccess', access: { chatId: 'observer', sourceChatId: 'source', ownMember: false } },
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: true } },
    ], revisions: [] })
    await store.ingest(account, batch(...['source', 'observer', 'participant'].map(chat_id => message(chat_id, 'orchid history', 1, { chat_id }))))
    const applied = await store.ingest(account, { writes: [], revisions: [
      { revision: '20', writes: [{ type: 'deleteChat', chatId: 'source' }] },
    ], throughRevision: '20' })
    expect(applied).toEqual([{ type: 'deleteChat', chatId: 'source' }, { type: 'deleteChat', chatId: 'observer' }])
    const reader = rig.reopen()
    expect(ids(await reader.windows(account, ['source', 'observer', 'participant'], 10))).toEqual(['participant'])
    expect(await reader.throughRevision(account)).toBe('20')
    await reader.ingest(account, batch(message('late-observer', 'late', 2, { chat_id: 'observer' })))
    expect((await reader.page(account, { chatId: 'observer', limit: 40 })).rows).toEqual([])
    // A relation first learned after the departure must also reject a late page.
    await reader.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'late-topic', sourceChatId: 'source', ownMember: false } },
      { type: 'put', message: message('late-topic-row', 'late', 1, { chat_id: 'late-topic' }) },
    ], revisions: [] })
    expect((await reader.page(account, { chatId: 'late-topic', limit: 40 })).rows).toEqual([])
    await reader.ingest(account, { writes: [{ type: 'deleteChat', chatId: 'participant' }], revisions: [] })
    expect(await reader.windows(account, ['participant'], 10)).toEqual([])
  })

  it('uses raw archival facts and rolls back access cleanup with a failing page, without treating unknown memberships as absent', async () => {
    await setup()
    await store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'chat-a', sourceChatId: null } },
      { type: 'put', message: message('kept') },
    ], revisions: [] })
    await expect(store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'chat-a', archived: true } },
      { type: 'put', message: { ...message('invalid'), seq: Number.NaN } },
    ], revisions: [], throughRevision: '21' })).rejects.toThrow('Invalid message sequence')
    expect(ids(await store.windows(account, ['chat-a'], 10))).toEqual(['kept'])
    expect(await store.throughRevision(account)).toBeNull()
    await store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'chat-a', archived: true } }], revisions: [] })
    await store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'chat-a', ownMember: true } }, { type: 'put', message: message('late') }], revisions: [] })
    expect(await store.windows(account, ['chat-a'], 10)).toEqual([])
  })

  it('ignores a stale topic-list membership after an explicit membership fact or revocation', async () => {
    await setup()
    await store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: true, membershipRevoked: false, revision: '10' } },
      { type: 'put', message: message('owned-history', 'orchid', 1, { chat_id: 'participant' }) },
    ], revisions: [] })
    // The shared topic-list request began before this member joined, and its response arrives later.
    await store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: false, revision: '9' } },
      { type: 'deleteChat', chatId: 'source' },
    ], revisions: [] })
    expect(ids((await store.page(account, { chatId: 'participant', limit: 10 })).rows)).toEqual(['owned-history'])
    await store.ingest(account, { writes: [], revisions: [{ revision: '11', writes: [{ type: 'deleteChat', chatId: 'participant' }] }] })
    // An older positive list response must not reopen a conversation after a newer explicit departure.
    await store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'participant', sourceChatId: 'source', ownMember: true, revision: '10' } },
      { type: 'put', message: message('late-body', 'late', 2, { chat_id: 'participant' }) },
    ], revisions: [] })
    expect((await store.page(account, { chatId: 'participant', limit: 10 })).rows).toEqual([])
  })

  it('d5b: keeps an observer topic on an absent own membership, until its source membership is revoked', async () => {
    await setup()
    await store.ingest(account, { writes: [
      { type: 'chatAccess', access: { chatId: 'source', ownMember: true, revision: '5' } },
      { type: 'chatAccess', access: { chatId: 'observer', sourceChatId: 'source', ownMember: false, revision: '5' } },
      { type: 'put', message: message('observer-history', 'orchid', 1, { chat_id: 'observer' }) },
    ], revisions: [] })
    await store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'observer', ownMember: false, revision: '6' } }], revisions: [] })
    expect(ids((await store.page(account, { chatId: 'observer', limit: 10 })).rows)).toEqual(['observer-history'])
    await store.ingest(account, { writes: [], revisions: [{ revision: '7', writes: [{ type: 'deleteChat', chatId: 'source' }] }] })
    expect((await store.page(account, { chatId: 'observer', limit: 10 })).rows).toEqual([])
  })

  it('clears one account history durably without admitting an older in-flight page', async () => {
    await setup()
    await store.ingest(account, batch(message('old', 'orchid old', 1), message('new', 'orchid new', 2, { created_at: '2026-11-14T00:00:01Z' })))
    await store.ingest('peer', batch(message('peer-old', 'orchid old', 1)))
    await store.ingest(account, { writes: [{ type: 'chatAccess', access: { chatId: 'chat-a', clearedAt: '2026-11-14T00:00:00Z', revision: '9007199254740993' } }], revisions: [] })
    expect(ids((await store.page(account, { chatId: 'chat-a', limit: 20 })).rows)).toEqual(['new'])
    expect(ids((await store.page('peer', { chatId: 'chat-a', limit: 20 })).rows)).toEqual(['peer-old'])
    const reopened = rig.reopen()
    await reopened.ingest(account, batch(message('late-old', 'orchid resurrected', 3)))
    expect(ids(await reopened.windows(account, ['chat-a'], 20))).toEqual(['new'])
  })
})

// The phone keeps what a chat window can show (MAX_WINDOW rows per main stream); the desktop keeps every row for local
// search. Rows and their coverage leave together, so an older read is not covered and goes to the server.
describe('phone retention (indexeddb)', () => {
  it('keeps the newest window of a main stream, with coverage only over the kept rows, across a reopen', async () => {
    const { MAX_WINDOW } = await import('../../../../../src/store/chatMessageWindow')
    const indexedDb = new IDBFactory()
    const store = createLocalMessageStore({ indexedDb })
    const count = MAX_WINDOW + 5
    const rows = Array.from({ length: count }, (_, index) => message(`m${index + 1}`, 'orchid', index + 1))
    await store.ingest(account, { writes: rows.map(row => ({ type: 'put', message: row })), revisions: [],
      ranges: [{ chatId: 'chat-a', threadRootId: null, fromSeq: 1, toSeq: count }] })
    const reply = message('reply', 'orchid', count + 1, { thread_root_id: 'm1' })
    await store.ingest(account, batch(reply))
    store.close()
    const reopened = createLocalMessageStore({ indexedDb })
    const window = await reopened.windows(account, ['chat-a'], count)
    expect(window.map(row => row.seq)).toEqual(Array.from({ length: MAX_WINDOW }, (_, index) => index + 6))
    expect(await reopened.page(account, { chatId: 'chat-a', beforeSeq: 6, limit: 5 })).toEqual({ rows: [], covered: false })
    expect((await reopened.page(account, { chatId: 'chat-a', beforeSeq: count + 1, limit: 40 })).covered).toBe(true)
    // A thread keeps its replies; retention is per main stream.
    expect(ids((await reopened.page(account, { chatId: 'chat-a', threadRootId: 'm1', limit: 10 })).rows)).toContain('reply')
    reopened.close()
  })
})
