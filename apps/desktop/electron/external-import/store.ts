import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'
import type {
  ExternalConversation,
  ExternalImportHistoryEntry,
  ExternalImportPage,
  ExternalImportSource,
  ExternalMessage,
} from '../../src/session/shared/core/session-import/external-conversation-import'
import { openPhysicalDatabase } from '../session/main/db/physical-connection'

const PAGE_SIZE = 40

export class ExternalHistoryStore {
  private connection: Database.Database | undefined

  constructor(private readonly directory: string) {}

  private database(): Database.Database {
    if (this.connection) return this.connection
    mkdirSync(this.directory, { recursive: true, mode: 0o700 })
    const db = openPhysicalDatabase(join(this.directory, 'history.sqlite'))
    try {
      db.pragma('foreign_keys = ON')
      db.pragma('busy_timeout = 5000')
      db.exec(`
        CREATE TABLE IF NOT EXISTS external_history (
          id TEXT PRIMARY KEY,
          owner TEXT NOT NULL,
          source TEXT NOT NULL,
          title TEXT NOT NULL,
          importedAt INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS external_history_by_owner ON external_history (owner, source, importedAt);
        CREATE TABLE IF NOT EXISTS external_history_message (
          historyId TEXT NOT NULL REFERENCES external_history(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          role TEXT NOT NULL,
          text TEXT NOT NULL,
          at INTEGER,
          PRIMARY KEY (historyId, seq)
        );
      `)
      this.connection = db
      return db
    } catch (error) {
      db.close()
      throw error
    }
  }

  private historyId(owner: string, source: ExternalImportSource, sourceId: string): string {
    return createHash('sha256').update(JSON.stringify([owner, source, sourceId])).digest('hex')
  }

  has(owner: string, source: ExternalImportSource, sourceId: string): boolean {
    return this.database().prepare('SELECT 1 FROM external_history WHERE id = ?').get(this.historyId(owner, source, sourceId)) !== undefined
  }

  import(owner: string, source: ExternalImportSource, row: ExternalConversation): ExternalImportHistoryEntry | null {
    const db = this.database()
    const sessionId = this.historyId(owner, source, row.sourceId)
    const importedAt = Date.now()
    const add = db.transaction(() => {
      const added = db.prepare('INSERT INTO external_history (id, owner, source, title, importedAt) VALUES (?, ?, ?, ?, ?) ON CONFLICT(id) DO NOTHING')
        .run(sessionId, owner, source, row.title, importedAt)
      if (!added.changes) return null
      const insert = db.prepare('INSERT INTO external_history_message (historyId, seq, role, text, at) VALUES (?, ?, ?, ?, ?)')
      row.messages.forEach((item, seq) => insert.run(sessionId, seq, item.role, item.text, item.at))
      return { sessionId, projectId: null, title: row.title, importedAt }
    })
    return add()
  }

  list(owner: string, source: ExternalImportSource): ExternalImportHistoryEntry[] {
    const rows = this.database().prepare('SELECT id AS sessionId, title, importedAt FROM external_history WHERE owner = ? AND source = ? ORDER BY importedAt DESC, id')
      .all(owner, source) as Omit<ExternalImportHistoryEntry, 'projectId'>[]
    return rows.map(row => ({ ...row, projectId: null }))
  }

  read(owner: string, sessionId: string, offset: number): ExternalImportPage | null {
    const db = this.database()
    const row = db.prepare('SELECT title FROM external_history WHERE owner = ? AND id = ?').get(owner, sessionId) as { title: string } | undefined
    if (!row) return null
    const messages = db.prepare('SELECT role, text, at FROM external_history_message WHERE historyId = ? AND seq >= ? ORDER BY seq LIMIT ?')
      .all(sessionId, offset, PAGE_SIZE + 1) as ExternalMessage[]
    return {
      title: row.title,
      messages: messages.slice(0, PAGE_SIZE),
      nextOffset: messages.length > PAGE_SIZE ? offset + PAGE_SIZE : null,
    }
  }

  close(): void {
    this.connection?.close()
    this.connection = undefined
  }
}
