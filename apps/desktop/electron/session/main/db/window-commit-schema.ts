import { sql } from 'drizzle-orm';
import { check, index, integer, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/** Small write-ahead receipts only. Canonical bodies remain in session_turns. */
export function windowCommitTables(columns: { sessionId: AnySQLiteColumn; rowId: AnySQLiteColumn }) {
  const sessionWindowCommitReceipts = sqliteTable('session_window_commit_receipts', {
    sourceId: text('source_id').primaryKey().notNull(),
    sessionId: text('session_id').notNull().references(() => columns.sessionId, { onDelete: 'cascade' }),
    rowId: text('row_id').notNull().references(() => columns.rowId, { onDelete: 'cascade' }),
    storedSeq: integer('stored_seq').notNull(),
    referenceId: text('reference_id').notNull(),
    receipt: text('receipt').notNull(),
  }, table => ({ row: index('session_window_receipts_row').on(table.rowId), size: check('session_window_receipt_bytes', sql`length(CAST(${table.receipt} AS BLOB)) <= 4096`) }));

  const sessionWindowCommitPositions = sqliteTable('session_window_commit_positions', {
    rowId: text('row_id').primaryKey().notNull().references(() => columns.rowId, { onDelete: 'cascade' }),
    sessionId: text('session_id').notNull().references(() => columns.sessionId, { onDelete: 'cascade' }),
    referenceId: text('reference_id').notNull(),
    sourceId: text('source_id').notNull().references(() => sessionWindowCommitReceipts.sourceId, { onDelete: 'cascade' }),
  }, table => ({ reference: uniqueIndex('session_window_positions_reference').on(table.sessionId, table.referenceId) }));
  return { sessionWindowCommitReceipts, sessionWindowCommitPositions };
}
