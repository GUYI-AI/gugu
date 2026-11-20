import type Database from 'better-sqlite3';
import { opendirSync, type Dir } from 'node:fs';
import { INLINE_PAYLOAD_BYTES, TurnPayloadFiles, unbindTurnPayloadDirectory, type TurnPayloadRef } from './session-turn-payloads';
import { coreLogger } from '@gugu/core/log';
import { runTurnRows } from './session-turn-sql';

type State = { files: TurnPayloadFiles; writers: number; timer?: NodeJS.Timeout; scanDone: boolean; scan?: Dir; statements?: ReturnType<typeof prepareStatements> };
const log = coreLogger('session-turn-payloads');
const states = new WeakMap<Database.Database, State>();
function state(connection: Database.Database): State {
  let value = states.get(connection);
  if (!value) {
    if (!connection.name || connection.name === ':memory:') throw new Error('Durable turn payloads need a file-backed database');
    const metadata = connection.prepare('SELECT bytes,kind,inline_data IS NOT NULL AS inlined,length(inline_data) AS inline_bytes FROM session_turn_payload_objects WHERE hash=?');
    const inline = connection.prepare('SELECT substr(inline_data,1,65536) AS data FROM session_turn_payload_objects WHERE hash=? AND inline_data IS NOT NULL');
    const chunks = connection.prepare('SELECT digest FROM session_turn_payload_chunks WHERE hash=? AND ordinal>=? AND ordinal<? ORDER BY ordinal');
    const files = new TurnPayloadFiles(`${connection.name}.turn-payloads`, undefined, {
      alive: () => connection.open,
      metadata(hash) {
        const row = metadata.get(hash) as { bytes: number; kind: number; inlined: number; inline_bytes: number | null } | undefined;
        if (row?.inlined && (row.inline_bytes !== row.bytes || row.bytes > INLINE_PAYLOAD_BYTES)) throw new Error('Invalid bounded SQLite payload');
        return row ? { bytes: row.bytes, kind: row.kind, inline: Boolean(row.inlined) } : undefined;
      },
      inline(hash) {
        const row = inline.get(hash) as { data: Buffer } | undefined;
        if (!row || !Buffer.isBuffer(row.data)) throw new Error('Missing canonical inline payload');
        return row.data;
      },
      chunks(hash, first, count) { return (chunks.all(hash, first, first + count) as { digest: string }[]).map(row => row.digest); },
    });
    files.bind(connection.readonly);
    value = { files, writers: 0, scanDone: false };
    states.set(connection, value);
  }
  value.files.bind(connection.readonly);
  return value;
}
export const turnPayloadFiles = (connection: Database.Database): TurnPayloadFiles => state(connection).files;

function prepareStatements(connection: Database.Database) {
  return {
    put: connection.prepare('INSERT OR IGNORE INTO session_turn_payload_objects(hash,bytes,kind,inline_data) VALUES (?,?,?,?)'),
    size: connection.prepare('SELECT bytes,kind,inline_data IS NOT NULL AS inlined FROM session_turn_payload_objects WHERE hash=?'),
    chunk: connection.prepare('INSERT OR IGNORE INTO session_turn_payload_chunks(hash,ordinal,digest) VALUES (?,?,?)'),
    children: connection.prepare('SELECT child_hash FROM session_turn_payload_edges WHERE parent_hash=?'),
  };
}

function statements(connection: Database.Database) {
  const value = state(connection);
  return value.statements ??= prepareStatements(connection);
}

/** May be repeated after a rollback. Keep staging until the outer writer has settled. */
export function registerTurnPayloads(connection: Database.Database): void {
  if (!connection.inTransaction) throw new Error('Payload objects need a registry transaction');
  const files = state(connection).files;
  files.durable();
  const query = statements(connection), inserted = new Set<string>();
  for (const [hash, object] of files.staged) {
    let stored = query.size.get(hash) as { bytes: number; kind: number; inlined: number } | undefined;
    if (!stored) {
      query.put.run(hash, object.bytes, object.kind, object.bytes <= INLINE_PAYLOAD_BYTES ? object.data : null);
      stored = query.size.get(hash) as { bytes: number; kind: number; inlined: number };
      for (let ordinal = 0; ordinal < object.chunks.length; ordinal++) query.chunk.run(hash, ordinal, object.chunks[ordinal]);
      inserted.add(hash);
    }
    if (stored.bytes !== object.bytes || stored.kind !== object.kind || Boolean(stored.inlined) !== (object.bytes <= INLINE_PAYLOAD_BYTES))
      throw new Error('Payload registry size or storage mismatch');
  }
  // Consult the transaction, rather than optimistic JS flags: an earlier registration may have rolled back.
  const edges: string[][] = [];
  for (const [hash, object] of files.staged) if (object.children.size) {
    const existing = inserted.has(hash) ? new Set<string>()
      : new Set((query.children.all(hash) as { child_hash: string }[]).map(row => row.child_hash));
    for (const child of object.children.values()) if (!existing.has(child.hash)) edges.push([hash, child.hash]);
  }
  runTurnRows(connection, 'INSERT OR IGNORE INTO session_turn_payload_edges(parent_hash,child_hash) VALUES', edges);
}

export type TurnFieldPayloads = { nodeKey: string; field: string; roots: readonly TurnPayloadRef[] };
export function ownTurnFieldsPayloads(connection: Database.Database, rowId: string, fields: readonly TurnFieldPayloads[]): void {
  // Check this transaction, rather than the head observed before asynchronous source publication.
  const replace = connection.prepare('SELECT 1 FROM session_turn_payload_fields WHERE row_id=? LIMIT 1').get(rowId);
  if (replace) runTurnRows(connection,
    'DELETE FROM session_turn_payload_fields WHERE (row_id,node_key,field) IN (VALUES',
    fields.map(field => [rowId, field.nodeKey, field.field]), ')');
  runTurnRows(connection, 'INSERT OR IGNORE INTO session_turn_payload_fields(row_id,node_key,field,hash) VALUES',
    fields.flatMap(field => field.roots.map(root => [rowId, field.nodeKey, field.field, root.hash])));
}

export function ownTurnSourcePayload(connection: Database.Database, sourceId: string, root: TurnPayloadRef): void {
  if (!connection.inTransaction) throw new Error('Payload source ownership must share its receipt transaction');
  // The normalized commit registered all prepared objects in this same transaction.
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
        await value.files.durableAsync();
        connection.transaction(() => registerTurnPayloads(connection))();
      }
    } finally {
      // A failed durability/registry attempt must not leave an unregistered object adoptable from staging.
      value.writers--;
      if (!value.writers) value.files.clear();
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
  for (let count = 0; count < 32 && performance.now() - started < 5 && !value.scanDone; count++) {
    if (!value.scan) {
      try { value.scan = opendirSync(value.files.directory, { bufferSize: 1 }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; value.scanDone = true; continue; }
    }
    const entry = value.scan.readSync();
    if (!entry) { value.scan.closeSync(); value.scan = undefined; value.scanDone = true; continue; }
    if (!entry.isFile()) continue;
    const match = /^([a-f0-9]{64})\.payload(?:\.([a-f0-9-]{36})\.tmp)?$/.exec(entry.name);
    if (!match) continue;
    const hash = match[1];
    if (match[2]) value.files.removeTemporary(hash, match[2]);
    else if (!connection.prepare('SELECT 1 FROM session_turn_payload_objects WHERE hash=?').get(hash)) value.files.remove(hash);
  }
  return !value.scanDone;
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
  unbindTurnPayloadDirectory(value.files.directory, value.files.access);
  states.delete(connection);
}
