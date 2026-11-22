import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openFixture, type FixtureDb } from '@tooling/utils/db'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { ImMessageBatch } from '@shared/core/im-messages'
import { createImMessageStore } from './store'

vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }))

let fixture: FixtureDb
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
const hits = (term: string, owner = account) => fixture.sqlite.prepare(`SELECT m.id FROM im_messages_text
  JOIN im_messages m ON m.rowid = im_messages_text.rowid
  WHERE im_messages_text MATCH ? AND m.account_id = ? ORDER BY m.id`).all(`"${term}"`, owner)
const stored = () => fixture.sqlite.prepare('SELECT rowid, * FROM im_messages ORDER BY account_id, id').all()
const integrity = () => fixture.sqlite.exec("INSERT INTO im_messages_text(im_messages_text) VALUES('integrity-check')")

// The storage contract itself runs against both adapters in contract.db.test.ts; these cases are SQLite's own (FTS, VACUUM, statements).
describe('durable local IM messages (SQLite adapter)', () => {
  beforeEach(async () => { fixture = await openFixture('empty') })
  afterEach(() => { vi.restoreAllMocks(); fixture.close() })

  it('searches stored history outside a display window, using projected short and trigram terms in the requested account and chat', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, batch(message('older', 'orchid 登录', 1),
      message('newer', 'current window', 500), message('elsewhere', 'orchid 登录', 1, { chat_id: 'chat-b' }),
      message('attachment', '[附件] orchid.png (image/png)\n[URL] https://private.invalid/excluded\n[Size] 1\n[Kind] image', 2, { content_type: 'attachment' })))
    store.ingest('account-b', batch(message('private', 'orchid 登录')))
    expect(store.windows(account, ['chat-a'], 1).map(row => row.id)).toEqual(['newer'])
    expect((await store.search(account, 'chat-a', 'orchid 登录', 50)).map(row => row.id)).toEqual(['older'])
    expect((await store.search(account, 'chat-a', '登录', 50)).map(row => row.id)).toEqual(['older'])
    expect((await store.search(account, 'chat-a', 'or', 50)).map(row => row.id)).toEqual(['older', 'attachment'])
    expect((await store.search(account, 'chat-a', 'im', 50))).toEqual([])
    expect((await store.search(account, 'chat-a', 'excluded', 50))).toEqual([])
    expect((await store.search(account, 'chat-a', 'never-stored', 50))).toEqual([])
    // No words (a quick filter on its own): every stored message of the chat, oldest first like any result.
    expect((await store.search(account, 'chat-a', '', 50)).map(row => row.id)).toEqual(['older', 'attachment', 'newer'])
    integrity()
  })

  it('upserts in place, stores the body once, and removes old FTS entries with recursive triggers off', async () => {
    const store = createImMessageStore(fixture.sqlite)
    expect(fixture.sqlite.pragma('recursive_triggers', { simple: true })).toBe(0)
    store.ingest(account, batch(message('one')))
    const first = stored()[0] as { rowid: number; rest: string; content: string }
    expect(first.content).toBe('orchid original')
    expect(Object.hasOwn(JSON.parse(first.rest), 'content')).toBe(false)
    expect(fixture.sqlite.prepare('SELECT text FROM im_messages_text').get()).toEqual({ text: null })
    store.ingest(account, batch(message('one')))
    store.ingest(account, batch(message('one', 'violet revised')))
    expect((stored()[0] as { rowid: number }).rowid).toBe(first.rowid)
    expect(hits('orchid')).toEqual([])
    expect(hits('violet')).toEqual([{ id: 'one' }])
    integrity()
  })

  it('keeps the explicit integer row IDs and FTS mappings stable across VACUUM', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, batch(message('removed'), message('kept', 'violet survivor', 2)))
    store.ingest(account, { writes: [{ type: 'delete', chatId: 'chat-a', id: 'removed' }], revisions: [] })
    const before = stored()
    fixture.sqlite.exec('VACUUM')
    expect(stored()).toEqual(before)
    expect(hits('violet')).toEqual([{ id: 'kept' }])
    integrity()
  })

  it('rolls back original rows, FTS and progress when a page fails', async () => {
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(account, { ...batch(message('one')), throughRevision: '1' })
    const before = stored()
    expect(() => store.ingest(account, { writes: [], revisions: [
      { revision: '2', writes: [{ type: 'put', message: message('one', 'violet revised') }] },
      { revision: '3', writes: [{ type: 'put', message: { ...message('invalid-sequence'), seq: Number.NaN } }] },
    ], throughRevision: '3' })).toThrow('Invalid message sequence')
    expect(stored()).toEqual(before)
    expect(store.throughRevision(account)).toBe('1')
    expect(hits('orchid')).toEqual([{ id: 'one' }])
    expect(hits('violet')).toEqual([])
    integrity()
  })

  it('compiles each statement once per connection, however many messages and access facts arrive', () => {
    const compiled = new Map<string, number>()
    const prepare = fixture.sqlite.prepare.bind(fixture.sqlite)
    vi.spyOn(fixture.sqlite, 'prepare').mockImplementation(((sql: string) => {
      compiled.set(sql, (compiled.get(sql) ?? 0) + 1)
      return prepare(sql)
    }) as typeof fixture.sqlite.prepare)
    const store = createImMessageStore(fixture.sqlite)
    for (let seq = 1; seq <= 5; seq++) {
      store.ingest(account, { writes: [], revisions: [{ revision: String(seq), writes: [
        { type: 'put', message: message(`m${seq}`, 'orchid', seq) },
        { type: 'chatAccess', access: { chatId: `topic-${seq}`, sourceChatId: 'chat-a', ownMember: seq % 2 === 0 } },
      ] }], throughRevision: String(seq) })
    }
    expect(store.windows(account, ['chat-a'], 10)).toHaveLength(5)
    expect([...compiled].filter(([, times]) => times > 1)).toEqual([])
  })
})
