import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import journal from '@root/drizzle/meta/_journal.json';

// Vite bundles all migration SQL files at build time — no runtime path resolution needed.
// Each value is the raw SQL string content of the file.
const sqlFiles = import.meta.glob('@root/drizzle/*.sql', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

type JournalEntry = { idx: number; when: number; tag: string; breakpoints: boolean };
export type PendingMigration = { tag: string; when: number; sql: string };

export function bundledMigrations(): PendingMigration[] {
  return (journal as { entries: JournalEntry[] }).entries.map((entry) => {
    const sqlKey = Object.keys(sqlFiles).find((k) => k.includes(entry.tag));
    if (!sqlKey) throw new Error(`Missing bundled SQL for migration: ${entry.tag}`);
    return { tag: entry.tag, when: entry.when, sql: sqlFiles[sqlKey] };
  });
}

/**
 * Applies every migration newer than the last recorded one, all in one transaction.
 *
 * @@@foreign-keys-off - `PRAGMA foreign_keys` is a no-op inside a transaction, so the `PRAGMA
 * foreign_keys=OFF` that drizzle-kit writes into table-rebuild migrations never took effect here: the
 * `DROP TABLE <old>` of a rebuild then runs its implicit DELETE with cascades on and empties every child
 * table pointing at it. Enforcement is therefore switched off around the transaction, and the result is
 * checked with `foreign_key_check` before commit: a violation the batch introduced throws and rolls the
 * whole batch back. Violations already in the database before the batch are not the batch's doing
 * (columns added by `ALTER TABLE … REFERENCES` never validated old rows), so they don't block it.
 */
export function applyMigrations(
  connection: BetterSqlite3.Database,
  migrations: readonly PendingMigration[]
): void {
  connection.exec(`
    CREATE TABLE IF NOT EXISTS __drizzle_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      hash TEXT NOT NULL,
      created_at NUMERIC
    )
  `);

  const lastRow = connection
    .prepare('SELECT created_at FROM __drizzle_migrations ORDER BY created_at DESC LIMIT 1')
    .get() as { created_at: number } | undefined;
  const lastTimestamp = lastRow?.created_at ?? 0;
  const pending = migrations.filter((migration) => migration.when > lastTimestamp);
  if (pending.length === 0) return;

  // Counted per child→parent pair, not per row: a rebuilt table gets new rowids, so a row-level diff would
  // report every old violation in it as new.
  const violations = () => {
    const counts = new Map<string, number>();
    for (const row of connection.pragma('foreign_key_check') as { table: string; parent: string }[]) {
      const pair = `${row.table}→${row.parent}`;
      counts.set(pair, (counts.get(pair) ?? 0) + 1);
    }
    return counts;
  };
  const enforced = connection.pragma('foreign_keys', { simple: true }) === 1;
  connection.pragma('foreign_keys = OFF');
  try {
    connection.transaction(() => {
      const before = violations();
      for (const migration of pending) {
        for (const stmt of migration.sql.split('--> statement-breakpoint')) {
          const trimmed = stmt.trim();
          if (trimmed) connection.exec(trimmed);
        }
        connection
          .prepare('INSERT INTO __drizzle_migrations (hash, created_at) VALUES (?, ?)')
          .run(createHash('sha256').update(migration.sql).digest('hex'), migration.when);
      }
      const introduced = [...violations()]
        .filter(([pair, n]) => n > (before.get(pair) ?? 0))
        .map(([pair, n]) => `${pair}: ${before.get(pair) ?? 0} → ${n}`);
      if (introduced.length > 0) {
        throw new Error(
          `Migrations ${pending.map((m) => m.tag).join(', ')} introduced foreign key violations (${introduced.join('; ')})`
        );
      }
    })();
  } finally {
    if (enforced) connection.pragma('foreign_keys = ON');
  }
}

const SEARCH_INDEX_VERSION = '10';
/**
 * Creates the FTS5 full-text search virtual table used by the command palette.
 * This is managed outside the Drizzle migration system because Drizzle cannot
 * generate FTS5 virtual table DDL. The table is version-gated via the `kv`
 * table so it can be safely dropped and recreated when the schema changes.
 */
function ensureSearchIndex(connection: BetterSqlite3.Database): void {
  connection.transaction(() => {
    // Bump this version string whenever the FTS schema changes — the table is
    // dropped and recreated, and backfill() + seedCommands() repopulate it.
    // 7: a session is indexed by its one name (task-name.ts), not the dropped `sessions.title` (6 was
    // already taken by the said-in-tasks search, so installs that built 6 rebuild once more).
    // 8: turn_text_rows.item_id holds the message's source identity, the one a reveal compares.
    // 9: extract each turn's identity before expanding its messages, including in live-write triggers.
    // 10: turn text and the turn index are written from each session's timeline (core/session-index), not session_turns.
    const row = connection.prepare(`SELECT value FROM kv WHERE key = 'fts_version'`).get() as
      | { value: string }
      | undefined;

    if (row?.value !== SEARCH_INDEX_VERSION) {
      connection.exec(`DROP TABLE IF EXISTS search_index`);
      ensureSessionIndex(connection);
      connection.exec(`
        CREATE VIRTUAL TABLE search_index USING fts5(
          item_type,
          item_id    UNINDEXED,
          project_id UNINDEXED,
          title,
          keywords,
          tokenize = 'trigram case_sensitive 0'
        )
      `);
      connection.prepare("DELETE FROM kv WHERE key IN ('turn_text_backfilled', 'turn_text_backfill_cursor') OR key LIKE 'session-index:%'").run();
      connection
        .prepare(
          `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('fts_version', ?, unixepoch())`
        )
        .run(SEARCH_INDEX_VERSION);
    }
  })();
}

/**
 * What each session's timeline holds, for the readers that ask about sessions not open (core/session-index writes it,
 * from the timeline, and nothing else does): `session_index_turns`, one row per turn (when, who began it, how it
 * ended), and `turn_text_rows`, what the person and the agent said in it, with `turn_text` its trigram FTS5 index
 * (external content). Derived, rebuilt from the records whenever the search index version changes.
 */
function ensureSessionIndex(connection: BetterSqlite3.Database): void {
  connection.exec(`
    DROP TABLE IF EXISTS turn_text;
    DROP TABLE IF EXISTS turn_text_rows;
    DROP TABLE IF EXISTS session_index_turns;
    CREATE TABLE session_index_turns (session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, turn_id TEXT NOT NULL, started_at INTEGER,
      ended_at INTEGER, initiator TEXT, outcome_kind TEXT, outcome_message TEXT, PRIMARY KEY (session_id, turn_id)) WITHOUT ROWID;
    CREATE INDEX session_index_turns_order ON session_index_turns (session_id, started_at);
    CREATE TABLE turn_text_rows (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions (id) ON DELETE CASCADE, turn_id TEXT NOT NULL,
      started_at INTEGER, item_id TEXT NOT NULL, role TEXT NOT NULL, text TEXT NOT NULL, activity TEXT, message_time TEXT);
    CREATE INDEX turn_text_rows_turn ON turn_text_rows (session_id, turn_id);
    CREATE VIRTUAL TABLE turn_text USING fts5(text, content = 'turn_text_rows', content_rowid = 'id', tokenize = 'trigram case_sensitive 0');
    CREATE TRIGGER turn_text_rows_insert AFTER INSERT ON turn_text_rows BEGIN
      INSERT INTO turn_text (rowid, text) VALUES (NEW.id, NEW.text);
    END;
    CREATE TRIGGER turn_text_rows_delete AFTER DELETE ON turn_text_rows BEGIN
      INSERT INTO turn_text (turn_text, rowid, text) VALUES ('delete', OLD.id, OLD.text);
    END;
  `);
}

/**
 * Creates the keyed identity table, FTS5 virtual table, and companion meta
 * table used for workspace file indexing. Managed outside Drizzle (same reason
 * as ensureSearchIndex).
 * Version-gated via `kv` so the tables can be dropped and recreated on schema
 * changes without a full Drizzle migration.
 */
function ensureFileIndex(connection: BetterSqlite3.Database): void {
  connection.transaction(() => {
    const FILE_INDEX_VERSION = '5';

    const row = connection.prepare(`SELECT value FROM kv WHERE key = 'file_index_version'`).get() as
      | { value: string }
      | undefined;

    if (row?.value === FILE_INDEX_VERSION) return;

    connection.exec(`DROP TABLE IF EXISTS workspace_file_index`);
    connection.exec(`DROP TABLE IF EXISTS workspace_file_index_rows`);
    connection.exec(`DROP TABLE IF EXISTS workspace_file_index_meta`);
    connection.exec(`
      CREATE TABLE workspace_file_index_rows (
        rowid        INTEGER PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        path         TEXT NOT NULL,
        filename     TEXT NOT NULL,
        UNIQUE(workspace_id, path)
      );
    `);
    connection.exec(`
      CREATE VIRTUAL TABLE workspace_file_index USING fts5(
        workspace_id UNINDEXED,
        path,
        filename,
        tokenize = 'trigram case_sensitive 0',
        content = ''
      )
    `);
    connection.exec(`
      CREATE TABLE workspace_file_index_meta (
        workspace_id     TEXT PRIMARY KEY,
        indexed_at       INTEGER NOT NULL,
        root_path        TEXT NOT NULL,
        status           TEXT NOT NULL
          CHECK (status IN ('complete', 'stale', 'truncated')),
        file_count       INTEGER NOT NULL,
        truncate_reason  TEXT
          CHECK (truncate_reason IS NULL OR truncate_reason IN ('maxEntries', 'timeBudget'))
      )
    `);
    connection
      .prepare(
        `INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES ('file_index_version', ?, unixepoch())`
      )
      .run(FILE_INDEX_VERSION);
  })();
}

/**
 * Runs all pending migrations against the provided SQLite connection (or the
 * app's shared singleton when called without arguments). Call this once in
 * main.ts before any db queries run.
 *
 * Accepts an explicit connection so migration tests and fixture generators can
 * pass an in-memory database without pulling in the Electron-dependent client
 * module at import time.
 *
 * Returns the connection that was used.
 */
export async function initializeDatabase(
  connection?: BetterSqlite3.Database
): Promise<BetterSqlite3.Database> {
  // Lazily import the app singleton only when no explicit connection is given.
  // This keeps the module importable in non-Electron environments (Vitest).
  const conn = connection ?? (await import('./client')).sqlite;
  conn.pragma('foreign_keys = ON');
  // Search text was once kept by triggers on session_turns, calling functions no connection registers any more.
  conn.exec(`DROP TRIGGER IF EXISTS session_turns_text_insert; DROP TRIGGER IF EXISTS session_turns_text_update;
    DROP TRIGGER IF EXISTS session_turns_text_delete;`);
  applyMigrations(conn, bundledMigrations());
  ensureSearchIndex(conn);
  ensureFileIndex(conn);
  return conn;
}
