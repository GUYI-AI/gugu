import Database from 'better-sqlite3';
import { closeSync, openSync, realpathSync, statSync } from 'node:fs';

const bindings = new WeakMap<Database.Database, { path: string; identity: string }>();
const identity = (path: string) => { const value = statSync(path, { bigint: true }); return `${value.dev}:${value.ino}`; };
const unavailable = () => Object.assign(new Error('The projection database gateway is unavailable'), { code: 'needs_location' });

/** Bind the synchronous SQLite open interval, never adopt an already-open
 * connection from a later pathname stat. The file is created first and SQLite
 * opens it with fileMustExist, so a path that vanishes mid-open fails instead of
 * SQLite creating an unrelated file there; the pathname must name the same inode
 * before and after the constructor. Only the DB file's own identity is compared:
 * its directory and timestamps change with unrelated sibling files and coarse
 * clocks, so they prove nothing about which file SQLite holds. No SQL or caller
 * callback runs in that interval. Do not open/close an extra descriptor for an
 * existing DB: POSIX close would release this process's SQLite file locks. */
export function openPhysicalDatabase(path: string): Database.Database {
  try { closeSync(openSync(path, 'ax')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const actual = realpathSync(path), before = identity(actual);
  let connection: Database.Database | undefined;
  try {
    connection = new Database(actual, { fileMustExist: true });
    let after: string;
    try { after = identity(actual); } catch (error) { throw Object.assign(unavailable(), { cause: error }); }
    if (after !== before) throw unavailable();
    bindings.set(connection, { path: actual, identity: before });
    return connection;
  } catch (error) { connection?.close(); throw error; }
}

export function physicalDatabaseBinding(connection: Database.Database): Readonly<{ path: string; identity: string }> {
  const binding = bindings.get(connection);
  if (!binding || !connection.open || identity(binding.path) !== binding.identity) throw unavailable();
  return binding;
}
