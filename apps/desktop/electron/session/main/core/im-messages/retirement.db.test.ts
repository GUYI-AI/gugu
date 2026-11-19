import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { openFixture, type FixtureDb } from '@tooling/utils/db'
import { messageItemFromRow } from '@gugu/core/cloud/messageItem'
import type { ImMessageBatch } from '@shared/core/im-messages'
import { bundledMigrations, initializeDatabase } from '../../db/initialize'
import { createImMessageStore } from './store'
import { imMessagesController } from './controller'

vi.mock('@main/db/client', () => ({ db: {}, sqlite: {} }))
let fixture: FixtureDb | undefined
afterEach(() => { fixture?.close(); fixture = undefined })
const A = 'account-a', B = 'account-b'
const message = (id: string, owner = A) => {
  const row = messageItemFromRow({ id, chat_id: 'chat', seq: 1, sender_user_id: owner,
    content_type: 'text', content: 'orchid retained', created_at: '2026-11-02T00:00:00Z' }, owner)!
  delete row.local_send_state
  return row
}
const batch = (id: string, owner = A): ImMessageBatch => ({
  writes: [{ type: 'put', message: message(id, owner) }],
  revisions: [], ranges: [{ chatId: 'chat', fromSeq: 1, toSeq: 1 }], throughRevision: '7',
})
const rows = (table: string, owner = A) => fixture!.sqlite.prepare('SELECT * FROM '+table+' WHERE account_id = ?').all(owner)
describe('permanent native IM retirement', () => {
  it('preserves normal cache-clear/relogin writes and exposes no retirement RPC', async () => {
    fixture = await openFixture('empty')
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(A, batch('before')); store.clearAccount(A); store.ingest(A, batch('after'))
    expect(store.windows(A, ['chat'], 10).map(row => row.id)).toEqual(['after'])
    expect(Object.keys(imMessagesController)).not.toContain('retireAccount')
    expect(Object.keys(imMessagesController)).not.toContain('retireNativeImMessageAccount')
  })
  it('retires and purges A atomically, rejects all later A batch writes/cursors, and preserves B', async () => {
    fixture = await openFixture('empty')
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(A, batch('old-a')); store.ingest(B, batch('old-b', B))
    store.retireAccount(A)
    for (const table of ['im_messages','im_message_accounts','im_message_ranges','im_message_chats','im_message_tombstones']) expect(rows(table)).toEqual([])
    expect(rows('im_message_retired_accounts')).toHaveLength(1)
    expect(() => store.ingest(A, batch('late-a'))).toThrow('im_account_retired')
    expect(() => store.ingest(A, { writes: [], revisions: [], throughRevision: '999' })).toThrow('im_account_retired')
    expect(store.throughRevision(A)).toBeNull()
    expect(await store.search(A, 'chat', 'orchid', 10)).toEqual([])
    store.ingest(B, batch('new-b', B))
    expect(store.windows(B, ['chat'], 10).map(row => row.id).sort()).toEqual(['new-b','old-b'])
    expect(await store.search(B, 'chat', 'orchid', 10)).toHaveLength(2)
  })
  it('fences a second connection with a batch captured before retirement and survives reopening/ordinary clearing', async () => {
    fixture = await openFixture('empty')
    const first = createImMessageStore(fixture.sqlite), late = batch('queued-a')
    const other = new Database(fixture.sqlite.name)
    try {
      const second = createImMessageStore(other)
      first.ingest(A, batch('before')); first.retireAccount(A)
      expect(() => second.ingest(A, late)).toThrow('im_account_retired')
      second.clearAccount(A)
      expect(() => createImMessageStore(other).ingest(A, late)).toThrow('im_account_retired')
      second.ingest(B, batch('b-control', B))
      expect(first.windows(B, ['chat'], 10).map(row => row.id)).toEqual(['b-control'])
    } finally { other.close() }
    const reopened = new Database(fixture.sqlite.name)
    try { expect(() => createImMessageStore(reopened).ingest(A, late)).toThrow('im_account_retired') }
    finally { reopened.close() }
  })
  it('blocks legacy prepared/direct SQL writers which bypass the new ingest method', async () => {
    fixture = await openFixture('empty')
    const sql = fixture.sqlite, store = createImMessageStore(sql)
    const legacyInsert = sql.prepare("INSERT INTO im_messages(account_id,id,chat_id,seq,created_at,content_type,content,is_whisper,to_user_ids,rest) VALUES(?,?,?,1,'2026-11-02T00:00:00Z','text','legacy',0,'[]','{}')")
    legacyInsert.run(A,'before','chat')
    store.ingest(B, batch('b', B))
    store.retireAccount(A)
    expect(() => legacyInsert.run(A,'late','chat')).toThrow('im_account_retired')
    for (const statement of [
      "INSERT INTO im_message_accounts VALUES('account-a','99')",
      "INSERT INTO im_message_chats(account_id,chat_id) VALUES('account-a','late')",
      "INSERT INTO im_message_ranges VALUES('account-a','chat','',1,1)",
      "INSERT INTO im_message_tombstones VALUES('account-a','chat','late')",
      "UPDATE im_messages SET account_id='account-a' WHERE account_id='account-b'",
      "UPDATE im_message_accounts SET account_id='account-a' WHERE account_id='account-b'",
    ]) expect(() => sql.exec(statement)).toThrow('im_account_retired')
    expect(store.windows(B, ['chat'], 10).map(row => row.id)).toEqual(['b'])
    expect(store.throughRevision(B)).toBe('7')
    expect(rows('im_messages')).toEqual([])
  })
  it('cannot commit a legacy writer snapshot opened before retirement', async () => {
    fixture = await openFixture('empty')
    const first = createImMessageStore(fixture.sqlite)
    first.ingest(A, batch('before'))
    const other = new Database(fixture.sqlite.name)
    try {
      const legacy = other.prepare("INSERT INTO im_messages(account_id,id,chat_id,seq,created_at,content_type,content,is_whisper,to_user_ids,rest) VALUES(?,?,?,1,'2026-11-02T00:00:00Z','text','legacy',0,'[]','{}')")
      legacy.run(A,'positive-before','chat')
      other.exec('BEGIN')
      try {
        expect(other.prepare('SELECT * FROM im_message_retired_accounts').all()).toEqual([])
        first.retireAccount(A)
        // WAL snapshot promotion must refuse a stale writer; it cannot commit
        // based on the old absence of the newly durable retirement marker.
        expect(() => legacy.run(A,'late','chat')).toThrow()
      } finally { other.exec('ROLLBACK') }
      expect(rows('im_messages')).toEqual([])
      expect(rows('im_message_retired_accounts')).toHaveLength(1)
    } finally { other.close() }
  })
  it('rolls back both retirement and cache/index changes when the purge cannot commit, then retries safely', async () => {
    fixture = await openFixture('empty')
    const store = createImMessageStore(fixture.sqlite)
    store.ingest(A, batch('retained')); store.ingest(B, batch('b', B))
    fixture.sqlite.exec("CREATE TRIGGER controlled_retire_failure BEFORE DELETE ON im_messages WHEN old.account_id='account-a' BEGIN SELECT RAISE(ABORT,'controlled purge refusal'); END")
    expect(() => store.retireAccount(A)).toThrow('controlled purge refusal')
    expect(rows('im_message_retired_accounts')).toEqual([])
    expect(store.windows(A, ['chat'], 10).map(row => row.id)).toEqual(['retained'])
    expect(await store.search(A, 'chat', 'orchid', 10)).toHaveLength(1)
    fixture.sqlite.exec('DROP TRIGGER controlled_retire_failure')
    store.retireAccount(A); store.retireAccount(A)
    expect(rows('im_message_retired_accounts')).toHaveLength(1)
    expect(() => store.ingest(A, batch('late'))).toThrow('im_account_retired')
    expect(store.windows(B, ['chat'], 10)).toHaveLength(1)
  })
  it('upgrades the previous installed schema without changing existing rows or migration receipts', async () => {
    fixture = await openFixture('empty', { through: '0053_personal_conversation_history' })
    const sql = fixture.sqlite
    sql.prepare("INSERT INTO im_messages(account_id,id,chat_id,seq,created_at,content_type,content,is_whisper,to_user_ids,rest) VALUES(?,?,?,1,'2026-11-02T00:00:00Z','text','kept',0,'[]','{}')").run(A,'kept','chat')
    sql.prepare('INSERT INTO im_message_accounts VALUES(?,?)').run(A,'19')
    const oldRows = sql.prepare('SELECT * FROM im_messages').all()
    const oldLedger = sql.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all()
    await initializeDatabase(sql)
    expect(sql.prepare('SELECT * FROM im_messages').all()).toEqual(oldRows)
    expect(sql.prepare('SELECT * FROM __drizzle_migrations ORDER BY id').all().slice(0,oldLedger.length)).toEqual(oldLedger)
    expect(rows('im_message_retired_accounts')).toEqual([])
    expect(createImMessageStore(sql).throughRevision(A)).toBe('19')
    await initializeDatabase(sql)
    expect(sql.prepare('SELECT * FROM __drizzle_migrations').all()).toHaveLength(oldLedger.length+1)
    expect(bundledMigrations().at(-1)?.tag).toBe('0054_retired_message_accounts')
    expect(sql.pragma('foreign_key_check')).toEqual([])
  })
  it('refuses an unmigrated connection instead of silently disabling the permanent fence', async () => {
    fixture = await openFixture('empty', { through: '0053_personal_conversation_history' })
    expect(() => createImMessageStore(fixture!.sqlite)).toThrow('no such table: im_message_retired_accounts')
  })
})
