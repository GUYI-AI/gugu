import type Database from 'better-sqlite3';

export type DatabaseSpace = { pageCount: number; freelistCount: number; pageSize: number };
export type DatabaseSpaceChange = { reason: string; before: DatabaseSpace; after: DatabaseSpace };

// Header-only readings, never dbstat or a scan of the tables.
export function databaseSpace(connection: Database.Database): DatabaseSpace {
  return {
    pageCount: connection.pragma('page_count', { simple: true }) as number,
    freelistCount: connection.pragma('freelist_count', { simple: true }) as number,
    pageSize: connection.pragma('page_size', { simple: true }) as number,
  };
}

// The freelist itself is the durable maintenance queue: a restart cannot lose it.
// Buffer diagnostics until idle too; migration/first-open never starts maintenance.
const changes = new WeakMap<Database.Database, DatabaseSpaceChange[]>();
export function recordDatabaseSpaceChange(connection: Database.Database, reason: string, before: DatabaseSpace): void {
  const pending = changes.get(connection) ?? [];
  pending.push({ reason, before, after: databaseSpace(connection) });
  changes.set(connection, pending.slice(-8));
}

export function takeDatabaseSpaceChanges(connection: Database.Database): DatabaseSpaceChange[] {
  const pending = changes.get(connection) ?? [];
  changes.delete(connection);
  return pending;
}
