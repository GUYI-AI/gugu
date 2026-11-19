import type Database from 'better-sqlite3';
import { opendirSync, type Dir } from 'node:fs';
import { join } from 'node:path';
import { TurnPayloadFiles, type TurnPayloadRef } from './session-turn-payloads';
import { coreLogger } from '@gugu/core/log';

type State = { files: TurnPayloadFiles; writers: number; timer?: NodeJS.Timeout; shard: number; scan?: Dir };
const log = coreLogger('session-turn-payloads');
const states = new WeakMap<Database.Database, State>();
function state(connection: Database.Database): State {
  let value = states.get(connection);
  if (!value) {
    if (!connection.name || connection.name === ':memory:') throw new Error('Durable turn payloads need a file-backed database');
    value = { files: new TurnPayloadFiles(`${connection.name}.turn-payloads`), writers: 0, shard: 0 };
    states.set(connection, value);
  }
  return value;
}
export const turnPayloadFiles = (connection: Database.Database): TurnPayloadFiles => state(connection).files;

/** May be repeated after a rollback. Keep staging until the outer writer has settled. */
export function registerTurnPayloads(connection: Database.Database): void {
  if (!connection.inTransaction) throw new Error('Payload objects need a registry transaction');
  const files = state(connection).files;
  const put = connection.prepare('INSERT OR IGNORE INTO session_turn_payload_objects(hash,bytes) VALUES (?,?)');
  const size = connection.prepare('SELECT bytes FROM session_turn_payload_objects WHERE hash=?');
  const edge = connection.prepare('INSERT OR IGNORE INTO session_turn_payload_edges(parent_hash,child_hash) VALUES (?,?)');
  for (const [hash, object] of files.staged) {
    put.run(hash, object.bytes);
    if ((size.get(hash) as { bytes: number }).bytes !== object.bytes) throw new Error('Payload registry size mismatch');
  }
  for (const [hash, object] of files.staged) for (const child of object.children.values()) edge.run(hash, child.hash);
}

export function ownTurnFieldPayloads(connection: Database.Database, rowId: string, nodeKey: string, field: string, roots: readonly TurnPayloadRef[]): void {
  connection.prepare('DELETE FROM session_turn_payload_fields WHERE row_id=? AND node_key=? AND field=?').run(rowId, nodeKey, field);
  const put = connection.prepare('INSERT OR IGNORE INTO session_turn_payload_fields(row_id,node_key,field,hash) VALUES (?,?,?,?)');
  for (const root of roots) put.run(rowId, nodeKey, field, root.hash);
}

export function ownTurnSourcePayload(connection: Database.Database, sourceId: string, root: TurnPayloadRef): void {
  if (!connection.inTransaction) throw new Error('Payload source ownership must share its receipt transaction');
  registerTurnPayloads(connection);
  connection.prepare('INSERT INTO session_turn_payload_sources(source_id,hash) VALUES (?,?)').run(sourceId, root.hash);
}

/** Prepared files remain protected across the asynchronous source publication, across sessions too. */
export async function withTurnPayloadWrite<T>(connection: Database.Database, write: () => T | Promise<T>): Promise<T> {
  const value = state(connection);
  value.writers++;
  try { return await write(); }
  finally {
    try {
      if (connection.open && value.files.staged.size) {
        connection.transaction(() => registerTurnPayloads(connection))();
        value.files.staged.clear();
      }
    } finally {
      value.writers--;
      schedule(connection, value, 0);
    }
  }
}

/** Bounded synchronous work. Deleting an object releases its children in the same registry transaction. */
export function collectTurnPayloads(connection: Database.Database, maxObjects = 32): number {
  const value = state(connection);
  if (value.writers || connection.inTransaction) return 0;
  const candidate = connection.prepare('SELECT 1 FROM session_turn_payload_objects WHERE refs=0 LIMIT 1').get();
  if (!candidate) return 0;
  // A search worker may still hold the SQLite snapshot from before a root was released.
  // PASSIVE never waits for readers. It can checkpoint the releasing commit only after
  // every older snapshot is gone; until then its files must remain readable too.
  const checkpoint = connection.pragma('wal_checkpoint(PASSIVE)') as Array<{ busy: number; log: number; checkpointed: number }>;
  if (checkpoint.length !== 1 || checkpoint[0].busy || checkpoint[0].checkpointed !== checkpoint[0].log) return 0;
  let count = 0;
  const started = performance.now();
  while (count < maxObjects && performance.now() - started < 5) {
    const object = connection.prepare('SELECT hash FROM session_turn_payload_objects WHERE refs=0 LIMIT 1').get() as { hash: string } | undefined;
    if (!object) break;
    connection.transaction(() => {
      value.files.remove(object.hash);
      connection.prepare('DELETE FROM session_turn_payload_objects WHERE hash=? AND refs=0').run(object.hash);
    })();
    count++;
  }
  return count;
}

/** Only startup needs filesystem discovery: normal failures are registered in the writer's finally. */
function collectCrashOrphans(connection: Database.Database, value: State): boolean {
  if (value.writers || connection.inTransaction) return true;
  const started = performance.now();
  for (let count = 0; count < 32 && performance.now() - started < 5 && value.shard < 256; count++) {
    const shard = value.shard.toString(16).padStart(2, '0');
    if (!value.scan) {
      try { value.scan = opendirSync(join(value.files.directory, shard), { bufferSize: 1 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; value.shard++; continue; }
    }
    const entry = value.scan.readSync();
    if (!entry) { value.scan.closeSync(); value.scan = undefined; value.shard++; continue; }
    if (!entry.isFile()) continue;
    const match = /^([a-f0-9]{62})\.payload(?:\.([a-f0-9-]{36})\.tmp)?$/.exec(entry.name);
    if (!match) continue;
    const hash = shard + match[1];
    if (match[2]) value.files.removeTemporary(hash, match[2]);
    else if (!connection.prepare('SELECT 1 FROM session_turn_payload_objects WHERE hash=?').get(hash)) value.files.remove(hash);
  }
  return value.shard < 256;
}

function schedule(connection: Database.Database, value: State, delay: number): void {
  if (value.timer || !connection.open) return;
  value.timer = setTimeout(() => {
    value.timer = undefined;
    if (!connection.open) { value.scan?.closeSync(); value.scan = undefined; return; }
    if (value.writers || connection.inTransaction) { schedule(connection, value, 1000); return; }
    try {
      const collected = collectTurnPayloads(connection), scanning = collectCrashOrphans(connection, value);
      schedule(connection, value, collected || scanning ? 10 : 60_000);
    } catch (error) {
      log.error({ err: error }, 'Session turn payload collection failed');
      schedule(connection, value, 60_000);
    }
  }, delay);
  value.timer.unref();
}

export function startTurnPayloadMaintenance(connection: Database.Database): void { schedule(connection, state(connection), 0); }

export function stopTurnPayloadMaintenance(connection: Database.Database): void {
  const value = states.get(connection);
  if (!value) return;
  clearTimeout(value.timer);
  value.scan?.closeSync();
  states.delete(connection);
}
