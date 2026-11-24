import type { MessageItem } from '@gugu/core/shared/types/chat'
import { projectMessageSearchText } from '@gugu/core/shared/ui/messageSearchText'
import type { ImMessageBatch, ImMessagePage } from '@shared/core/im-messages'
import { messageStoreOperations, requireId, type ChatAccessRow, type MessageStoreAdapter } from '@shared/core/im-message-store'
import { dropMessages, encodeRest, restore, reusingStatements, type MessageSqlDatabase, type StoredMessage } from './message-row'
import { searchMessages } from './search'

type AccessRecord = { chat_id: string; source_chat_id: string | null; own_member: number | null; membership_revoked: number;
  archived: number; membership_revision: string | null; chat_revision: string | null; history_cleared_at: string | null }

const accessRow = (row: AccessRecord): ChatAccessRow => ({ chatId: row.chat_id, sourceChatId: row.source_chat_id,
  ownMember: row.own_member === null ? null : row.own_member === 1, membershipRevoked: row.membership_revoked === 1,
  archived: row.archived === 1, membershipRevision: row.membership_revision, chatRevision: row.chat_revision,
  historyClearedAt: row.history_cleared_at })

/** The session SQLite adapter of the shared message store contract: storage only, every rule is in the contract. */
function sqliteAdapter(connection: MessageSqlDatabase, accountId: string): MessageStoreAdapter {
  const all = (sql: string, ...args: unknown[]) => connection.prepare(sql).all(accountId, ...args)
  const get = (sql: string, ...args: unknown[]) => connection.prepare(sql).get(accountId, ...args)
  const run = (sql: string, ...args: unknown[]) => connection.prepare(sql).run(accountId, ...args)
  const restoreAll = (rows: unknown[]) => (rows as StoredMessage[]).map(restore)
  return {
    transaction: body => connection.transaction(body)(),
    row(id) {
      const row = get('SELECT * FROM im_messages WHERE account_id=? AND id=?', id) as (StoredMessage & { claimed_revision: string | null }) | undefined
      return row && { message: restore(row), claimedRevision: row.claimed_revision }
    },
    putRow(message, claimedRevision) {
      // Compute before mutating; either the original row and index both change, or neither does.
      const text = projectMessageSearchText(message)
      const old = get('SELECT rowid FROM im_messages WHERE account_id=? AND id=?', message.id) as { rowid: number } | undefined
      if (old) connection.prepare('DELETE FROM im_messages_text WHERE rowid = ?').run(old.rowid)
      const row = connection.prepare(`INSERT INTO im_messages
        (account_id, id, chat_id, thread_root_id, seq, sender_user_id, created_at, content_type, content,
         is_whisper, to_user_ids, file_item_id, rest, claimed_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_id, id) DO UPDATE SET chat_id=excluded.chat_id,
          thread_root_id=excluded.thread_root_id, seq=excluded.seq, sender_user_id=excluded.sender_user_id,
          created_at=excluded.created_at, content_type=excluded.content_type, content=excluded.content,
          is_whisper=excluded.is_whisper, to_user_ids=excluded.to_user_ids,
          file_item_id=excluded.file_item_id, rest=excluded.rest, claimed_revision=excluded.claimed_revision
        RETURNING rowid`).get(accountId, message.id, message.chat_id, message.thread_root_id ?? null,
        message.seq, message.sender_user_id, message.created_at, message.content_type, message.content,
        Number(message.is_whisper === true), JSON.stringify(message.to_user_ids), message.file_item_id ?? null,
        encodeRest(message), claimedRevision) as { rowid: number }
      if (text) connection.prepare('INSERT INTO im_messages_text(rowid, text) VALUES (?, ?)').run(row.rowid, text)
      return restore(connection.prepare('SELECT * FROM im_messages WHERE rowid=?').get(row.rowid) as StoredMessage)
    },
    deleteRows(chatId, ids) {
      if (!ids) dropMessages(connection, 'account_id = ? AND chat_id = ?', accountId, chatId)
      else for (const id of ids) dropMessages(connection, 'account_id = ? AND chat_id = ? AND id = ?', accountId, chatId, id)
    },
    stream(chatId, root, after, before, limit, newer) {
      const stream = root ? '(thread_root_id=? OR id=?)' : 'thread_root_id IS NULL'
      return restoreAll(all(`SELECT * FROM im_messages WHERE account_id=? AND chat_id=?
        AND ${stream} AND seq<? AND seq>? ORDER BY seq ${newer ? 'ASC' : 'DESC'} LIMIT ?`,
      chatId, ...(root ? [root, root] : []), before, after, limit))
    },
    // Each correlated range reads only a window from the stream index; no historical row_number scan.
    latest: (chatIds, limit) => restoreAll(connection.prepare(`SELECT m.* FROM json_each(?) chats
      JOIN im_messages m ON m.rowid IN (SELECT rowid FROM im_messages
        WHERE account_id = ? AND chat_id = chats.value AND thread_root_id IS NULL
        ORDER BY seq DESC LIMIT ?) ORDER BY m.chat_id, m.seq`).all(JSON.stringify(chatIds), accountId, limit)),
    rows: ids => restoreAll(all('SELECT * FROM im_messages WHERE account_id=? AND id IN (SELECT value FROM json_each(?))', JSON.stringify(ids))),
    createdAt: chatId => (all('SELECT id, created_at FROM im_messages WHERE account_id=? AND chat_id=?', chatId) as
      { id: string; created_at: string }[]).map(row => ({ id: row.id, createdAt: row.created_at })),
    ranges: (chatId, root) => (all(`SELECT from_seq, to_seq FROM im_message_ranges WHERE account_id=? AND chat_id=?
      AND thread_root_id=? ORDER BY from_seq`, chatId, root) as { from_seq: number; to_seq: number }[])
      .map(row => ({ fromSeq: row.from_seq, toSeq: row.to_seq })),
    setRanges(chatId, root, ranges) {
      run('DELETE FROM im_message_ranges WHERE account_id=? AND chat_id=? AND thread_root_id=?', chatId, root)
      for (const range of ranges) run('INSERT INTO im_message_ranges VALUES(?,?,?,?,?)', chatId, root, range.fromSeq, range.toSeq)
    },
    dropRanges: chatId => { run('DELETE FROM im_message_ranges WHERE account_id=? AND chat_id=?', chatId) },
    tombstoned: (chatId, messageId) => !!get(`SELECT 1 FROM im_message_tombstones
      WHERE account_id = ? AND chat_id = ? AND message_id IN ('', ?) LIMIT 1`, chatId, messageId),
    tombstone: (chatId, messageId) => { run(`INSERT INTO im_message_tombstones(account_id, chat_id, message_id)
      VALUES (?, ?, ?) ON CONFLICT DO NOTHING`, chatId, messageId) },
    clearDeparture: chatId => { run(`DELETE FROM im_message_tombstones WHERE account_id=? AND chat_id=? AND message_id=''`, chatId) },
    access(chatId) {
      const row = get('SELECT * FROM im_message_chats WHERE account_id=? AND chat_id=?', chatId) as AccessRecord | undefined
      return row && accessRow(row)
    },
    putAccess(row) {
      run(`INSERT INTO im_message_chats(account_id,chat_id,source_chat_id,own_member,membership_revoked,archived,
        membership_revision,chat_revision,history_cleared_at) VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(account_id,chat_id) DO UPDATE SET source_chat_id=excluded.source_chat_id,own_member=excluded.own_member,
        membership_revoked=excluded.membership_revoked,archived=excluded.archived,membership_revision=excluded.membership_revision,
        chat_revision=excluded.chat_revision,history_cleared_at=excluded.history_cleared_at`,
      row.chatId, row.sourceChatId, row.ownMember === null ? null : Number(row.ownMember), Number(row.membershipRevoked),
      Number(row.archived), row.membershipRevision, row.chatRevision, row.historyClearedAt)
    },
    accessChildren: sourceChatId => (all('SELECT * FROM im_message_chats WHERE account_id=? AND source_chat_id=?',
      sourceChatId) as AccessRecord[]).map(accessRow),
    throughRevision: () => (get('SELECT through_revision FROM im_message_accounts WHERE account_id = ?') as
      { through_revision: string } | undefined)?.through_revision ?? null,
    setThroughRevision(revision) {
      run(`INSERT INTO im_message_accounts(account_id, through_revision) VALUES (?, ?)
        ON CONFLICT(account_id) DO UPDATE SET through_revision=excluded.through_revision`, revision)
    },
    clear() {
      dropMessages(connection, 'account_id = ?', accountId)
      for (const table of ['im_message_tombstones', 'im_message_accounts', 'im_message_chats', 'im_message_ranges']) {
        run(`DELETE FROM ${table} WHERE account_id = ?`)
      }
    },
  }
}

/** All durable messages and their derived index share the existing session connection. */
export function createImMessageStore(database: MessageSqlDatabase) {
  const connection = reusingStatements(database)
  const retired = connection.prepare('SELECT 1 FROM im_message_retired_accounts WHERE account_id = ?')
  const markRetired = connection.prepare('INSERT INTO im_message_retired_accounts(account_id) VALUES (?) ON CONFLICT DO NOTHING')
  const account = (accountId: string) => {
    requireId(accountId)
    return messageStoreOperations(sqliteAdapter(connection, accountId))
  }
  const ingest = connection.transaction((accountId: string, batch: ImMessageBatch) => {
    requireId(accountId)
    // Keep the native retirement fence and the shared store's writes in one
    // transaction: a late batch is either purged or rejected before any write.
    if (retired.get(accountId)) throw Object.assign(new Error('im_account_retired'), { code: 'im_account_retired' })
    return account(accountId).ingest(batch)
  })
  const retireAccount = connection.transaction((accountId: string) => {
    requireId(accountId)
    markRetired.run(accountId)
    account(accountId).clear()
  })
  return {
    ingest,
    windows: (accountId: string, chatIds: string[], limit: number): MessageItem[] => account(accountId).windows(chatIds, limit),
    page: (accountId: string, options: ImMessagePage) => account(accountId).page(options),
    throughRevision: (accountId: string) => account(accountId).throughRevision(),
    clearAccount: (accountId: string) => account(accountId).clear(),
    search: (accountId: string, chatId: string, query: string, limit: number, fromUserId?: string) =>
      searchMessages(connection, accountId, chatId, query, limit, fromUserId),
    /** Native trusted-deletion receiver only; never included in the RPC controller. */
    retireAccount,
  }
}
