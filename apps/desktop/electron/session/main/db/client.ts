import type Database from 'better-sqlite3';
import { openPhysicalDatabase } from './physical-connection';
import { resolveDatabasePath } from './path';
import { stopTurnPayloadMaintenance } from '../core/sessions/session-turn-payload-owners';
import { createAppDatabase } from './database';
export type { AppDb, DrizzleTx } from './database';

let sqliteInstance: Database.Database | undefined;

function getSqlite(): Database.Database {
  if (sqliteInstance) return sqliteInstance;

  const connection = openPhysicalDatabase(resolveDatabasePath());
  connection.pragma('journal_mode = WAL');
  connection.pragma('busy_timeout = 5000');
  sqliteInstance = connection;
  return connection;
}

// Keep the existing sqlite export stable while deferring native binding loading
// until a database consumer actually touches the connection.
export const sqlite = new Proxy({} as Database.Database, {
  get(_target, property) {
    const connection = getSqlite();
    const value = Reflect.get(connection, property, connection);
    return typeof value === 'function' ? value.bind(connection) : value;
  },
  set(_target, property, value) {
    const connection = getSqlite();
    return Reflect.set(connection, property, value, connection);
  },
}) as Database.Database;

export const db = createAppDatabase(sqlite);

/** Host lifetime proofs need this exact connection, not the stable proxy which
 * can resolve to a new incarnation after closeDatabase(). Opens no second DB. */
export function sessionDatabaseConnection(): Database.Database { return getSqlite(); }

export function closeDatabase(): void {
  if (!sqliteInstance) return;
  if (!sqliteInstance.open) return;
  stopTurnPayloadMaintenance(sqlite);
  sqliteInstance.pragma('wal_checkpoint(TRUNCATE)');
  sqliteInstance.close();
  sqliteInstance = undefined;
}
