import Database from 'better-sqlite3';
import { closeSync, openSync, realpathSync, statSync } from 'node:fs';
import { dirname } from 'node:path';

const bindings = new WeakMap<Database.Database, { path: string; identity: string }>();
const identity = (value: { dev: bigint; ino: bigint }) => `${value.dev}:${value.ino}`;
const snapshot = (path: string) => { const value = statSync(path, { bigint: true });
  return { identity: identity(value), stamp: `${identity(value)}:${value.ctimeNs}:${value.mtimeNs}` }; };
const unavailable = () => Object.assign(new Error('The projection database gateway is unavailable'), { code: 'needs_location' });

/** Bind the synchronous SQLite open interval, never adopt an already-open
 * connection from a later pathname stat. Both the file and its directory must
 * stay unchanged across open (including rename-away-and-back). No SQL or caller
 * callback runs in that interval. Do not open/close an extra descriptor for an
 * existing DB: POSIX close would release this process's SQLite file locks. */
export function openPhysicalDatabase(path: string): Database.Database {
  try { closeSync(openSync(path, 'ax')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const actual = realpathSync(path), parent = dirname(actual);
  const fileBefore = snapshot(actual), parentBefore = snapshot(parent);
  let connection: Database.Database | undefined;
  try {
    connection = new Database(actual);
    if (snapshot(actual).stamp !== fileBefore.stamp || snapshot(parent).stamp !== parentBefore.stamp) throw unavailable();
    bindings.set(connection, { path: actual, identity: fileBefore.identity });
    return connection;
  } catch (error) { connection?.close(); throw error; }
}

export function physicalDatabaseBinding(connection: Database.Database): Readonly<{ path: string; identity: string }> {
  const binding = bindings.get(connection);
  if (!binding || !connection.open || identity(statSync(binding.path, { bigint: true })) !== binding.identity) throw unavailable();
  return binding;
}
