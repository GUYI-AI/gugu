import type Database from 'better-sqlite3';

const ROWS_PER_BATCH = 64;
const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();

/** Bound native calls without changing the caller's canonical transaction or row triggers. */
export function runTurnRows(connection: Database.Database, prefix: string, rows: readonly (readonly unknown[])[], suffix = ''): void {
  if (!connection.inTransaction) throw new Error('Turn row batches must share the canonical transaction');
  if (!rows.length) return;
  const width = rows[0].length;
  // The widest turn row has nine columns: 64 rows stay below SQLite's 999 binding floor.
  if (!width || width > 9 || rows.some(row => row.length !== width)) throw new Error('Invalid turn row batch');
  let cache = statements.get(connection);
  if (!cache) { cache = new Map(); statements.set(connection, cache); }
  const tuple = `(${Array.from({ length: width }, () => '?').join(',')})`;
  for (let at = 0; at < rows.length; at += ROWS_PER_BATCH) {
    const batch = rows.slice(at, at + ROWS_PER_BATCH);
    const sql = `${prefix} ${batch.map(() => tuple).join(',')} ${suffix}`;
    let statement = cache.get(sql);
    if (!statement) {
      statement = connection.prepare(sql);
      if (cache.size >= 32) cache.delete(cache.keys().next().value!);
      cache.set(sql, statement);
    }
    statement.run(...batch.flat());
  }
}
