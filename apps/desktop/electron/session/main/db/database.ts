import type Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';

// Use the ORM's exported database type rather than instantiating its overloaded constructor type.
export type AppDb = BetterSQLite3Database<typeof schema>;
/** The application owns this connection contract; it is not a private ORM property. */
export type ConnectedAppDb = AppDb & { readonly connection: Database.Database };
export type DrizzleTx = Parameters<AppDb['transaction']>[0] extends (tx: infer T) => unknown ? T : never;

export function createAppDatabase(connection: Database.Database): ConnectedAppDb {
  return Object.assign(drizzle(connection, { schema }), { connection });
}
