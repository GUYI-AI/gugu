import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, realpathSync, statSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { physicalDatabaseBinding } from '../../db/physical-connection';

type Connection = Database.Database;
const physical = (path: string) => { const value = statSync(path, { bigint: true }); return `${value.dev}:${value.ino}`; };
const fault = () => Object.assign(new Error('The projection database gateway is unavailable'), { code: 'needs_location' });

/** A kernel-held guard for the actual open DB, shared across profiles and cache
 * directories. Its name uses the DB inode, so symlink/hardlink aliases contend.
 * The OS account directory deliberately ignores HOME/GUGU_HOME/TMPDIR overrides.
 * Guard files are permanent: never unlink a live kernel lock or infer its owner
 * from a PID, timestamp, a new epoch or Electron's different instance locks. */
export function openWindowProjectionGateway(connection: Connection, directory: string, lockDirectory = join(userInfo().homedir, '.gugu', 'window-gateway-locks')) {
  if (!connection.open || !connection.name || connection.name === ':memory:') throw fault();
  const binding = physicalDatabaseBinding(connection), database = binding.path, cache = realpathSync(directory);
  const identity = binding.identity, cacheIdentity = physical(cache);
  mkdirSync(lockDirectory, { recursive: true, mode: 0o700 });
  const file = join(realpathSync(lockDirectory), `${createHash('sha256').update(identity).digest('hex')}.sqlite`);
  const guard = new Database(file, { timeout: 0 });
  try { chmodSync(file, 0o600); guard.exec('PRAGMA journal_mode=DELETE; BEGIN EXCLUSIVE'); }
  catch (error) { guard.close(); throw Object.assign(fault(), { cause: error }); }
  const guardIdentity = physical(file);
  let invalid = false, closing = false, pending = 0;
  const idle = new Set<() => void>();
  const proof = { namespace: JSON.stringify([identity, cacheIdentity]), assertHeld() {
    try {
      if (invalid || !connection.open || !guard.open || !guard.inTransaction || physical(file) !== guardIdentity
        || physical(database) !== identity || physical(cache) !== cacheIdentity) throw fault();
    } catch (error) { invalid = true; throw Object.assign(fault(), { cause: error }); }
  } };
  try { proof.assertHeld(); } catch (error) { guard.close(); throw error; }
  return {
    proof,
    async run<T>(read: () => Promise<T>): Promise<T> {
      if (closing) throw fault(); proof.assertHeld(); pending++;
      try { const value = await read(); proof.assertHeld(); return value; }
      finally { pending--; if (!pending) for (const resolve of idle) resolve(); }
    },
    /** Call only after resident owners are revoked and their cleanup is queued.
     * New operations stop now; the kernel lock outlives every admitted operation. */
    async close() {
      closing = true;
      if (pending) await new Promise<void>(resolve => idle.add(resolve));
      idle.clear(); invalid = true; if (guard.open) guard.close();
    },
  };
}
