import Database from 'better-sqlite3';
import { statSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
import { reclaimDatabase, type ReclaimResult } from './reclaim';

export type MaintenanceTarget = { path: string; identity: string };
export type MaintenanceJob = { targets: MaintenanceTarget[]; cancellation: SharedArrayBuffer };
export type MaintenanceReading = { path: string; result?: ReclaimResult; error?: string };

const identity = (path: string) => { const stat = statSync(path, { bigint: true }); return `${stat.dev}:${stat.ino}`; };

export async function maintainDatabases(job: MaintenanceJob): Promise<MaintenanceReading[]> {
  const cancelled = () => Atomics.load(new Int32Array(job.cancellation), 0) !== 0;
  const readings: MaintenanceReading[] = [];
  for (const target of job.targets) {
    if (cancelled()) break;
    let connection: Database.Database | undefined;
    try {
      if (identity(target.path) !== target.identity) throw new Error('Database identity changed before maintenance');
      connection = new Database(target.path, { fileMustExist: true, timeout: 0 });
      if (identity(target.path) !== target.identity) throw new Error('Database identity changed during maintenance open');
      readings.push({ path: target.path, result: await reclaimDatabase(connection, cancelled) });
    } catch (error) {
      readings.push({ path: target.path, error: String(error) });
    } finally { connection?.close(); }
  }
  return readings;
}

// Importable by the native-binding tests without starting any worker or SQL.
if (parentPort) {
  const port = parentPort;
  void maintainDatabases(workerData as MaintenanceJob).then(
    readings => { port.postMessage(readings); port.close(); },
    error => { port.postMessage([{ path: '', error: String(error) }]); port.close(); },
  );
}
