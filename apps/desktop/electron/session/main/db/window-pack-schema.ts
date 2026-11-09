import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, primaryKey, sqliteTable, text, type AnySQLiteColumn } from 'drizzle-orm/sqlite-core';

/** Disposable bounded projection offsets; bodies remain in canonical rows and
 * receipt-owned source files. Old readers do not need these private tables. */
export function windowPackTables(columns: { sessionId: AnySQLiteColumn; sourceId: AnySQLiteColumn }) {
  const sessionWindowPackGroups = sqliteTable('session_window_pack_groups', {
    groupId: text('group_id').primaryKey().notNull(),
    sessionId: text('session_id').notNull().references(() => columns.sessionId, { onDelete: 'cascade' }),
    state: text('state', { enum: ['building','complete','invalid','abandoned'] }).notNull(),
    physical: text('physical'),
  }, t => ({ recovery: index('session_window_pack_recovery').on(t.state,t.groupId),
    state: check('session_window_pack_state',sql`${t.state} IN ('building','complete','invalid','abandoned')`),
    size: check('session_window_pack_physical_bytes',sql`${t.physical} IS NULL OR length(CAST(${t.physical} AS BLOB)) <= 512`) }));
  const sessionWindowPackSources = sqliteTable('session_window_pack_sources', {
    groupId: text('group_id').notNull().references(() => sessionWindowPackGroups.groupId, { onDelete: 'cascade' }),
    sourceId: text('source_id').notNull().references(() => columns.sourceId, { onDelete: 'cascade' }),
  }, t => ({ pk: primaryKey({ columns: [t.groupId,t.sourceId] }) }));
  const sessionWindowPackFrames = sqliteTable('session_window_pack_frames', {
    groupId: text('group_id').notNull().references(() => sessionWindowPackGroups.groupId, { onDelete: 'cascade' }),
    frameName: text('frame_name').notNull(),
    sourceId: text('source_id').notNull().references(() => columns.sourceId, { onDelete: 'cascade' }),
    offset: integer('offset').notNull(), length: integer('length').notNull(), sha256: text('sha256').notNull(),
  }, t => ({ pk: primaryKey({ columns: [t.groupId,t.frameName] }),
    offset: check('session_window_pack_offset',sql`${t.offset} >= 0`),
    length: check('session_window_pack_length',sql`${t.length} >= 48 AND ${t.length} <= 65584`),
    hash: check('session_window_pack_hash',sql`length(${t.sha256}) = 64`) }));
  const sessionWindowPackPositions = sqliteTable('session_window_pack_positions', {
    frameName: text('frame_name').primaryKey().notNull(), groupId: text('group_id').notNull(),
  }, t => ({ frame: foreignKey({ columns: [t.groupId,t.frameName], foreignColumns: [sessionWindowPackFrames.groupId,sessionWindowPackFrames.frameName] }).onDelete('cascade') }));
  const sessionWindowPackDependencies = sqliteTable('session_window_pack_dependencies', {
    groupId: text('group_id').notNull().references(() => sessionWindowPackGroups.groupId, { onDelete: 'cascade' }),
    dependencyId: text('dependency_id').notNull(), frameName: text('frame_name').notNull(), sha256: text('sha256').notNull(),
  }, t => ({ pk: primaryKey({ columns: [t.groupId,t.dependencyId,t.frameName] }),
    frame: foreignKey({ columns: [t.dependencyId,t.frameName], foreignColumns: [sessionWindowPackFrames.groupId,sessionWindowPackFrames.frameName] }).onDelete('cascade') }));
  return { sessionWindowPackGroups,sessionWindowPackSources,sessionWindowPackFrames,sessionWindowPackPositions,sessionWindowPackDependencies };
}
