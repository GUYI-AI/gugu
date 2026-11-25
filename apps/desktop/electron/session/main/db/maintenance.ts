import { Worker } from 'node:worker_threads';
import { desktopWorkerPath } from '../worker-manifest';
import { beginDatabaseMaintenance, databaseQuietFor, noteDatabaseActivity } from './maintenance-activity';
import type { MaintenanceJob, MaintenanceReading, MaintenanceTarget } from './maintenance-worker';

export const DATABASE_IDLE_MS = 60_000;

function runWorker(job: MaintenanceJob): Promise<MaintenanceReading[]> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(desktopWorkerPath('database-maintenance'), { workerData: job, name: 'database-maintenance' });
    let replied = false;
    worker.once('message', (readings: MaintenanceReading[]) => { replied = true; resolve(readings); });
    worker.once('error', reject);
    worker.once('exit', code => { if (!replied) reject(new Error(`Database maintenance exited without a result (${code})`)); });
  });
}

/** start() installs only a timer. No DB open, page reading or worker on boot. */
export function createDatabaseMaintenance(options: {
  idle(): boolean;
  quiet?(): boolean;
  targets(): MaintenanceTarget[];
  report(readings: MaintenanceReading[]): void;
  run?: (job: MaintenanceJob) => Promise<MaintenanceReading[]>;
}) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let control: ReturnType<typeof beginDatabaseMaintenance> | undefined;
  let stopped = true;
  const schedule = (delay = DATABASE_IDLE_MS) => {
    if (stopped) return;
    timer = setTimeout(tick, delay);
    timer.unref();
  };
  const tick = () => {
    timer = undefined;
    if (stopped) return;
    try {
      if (!(options.quiet?.() ?? databaseQuietFor(DATABASE_IDLE_MS)) || !options.idle()) { schedule(); return; }
    } catch (error) {
      options.report([{ path: '', error: String(error) }]);
      schedule();
      return;
    }
    control = beginDatabaseMaintenance();
    running = (async () => {
      let reclaimed = false;
      try {
        const readings = await (options.run ?? runWorker)({ targets: options.targets(), cancellation: control!.buffer });
        reclaimed = readings.some(reading => reading.result?.state === 'reclaimed');
        options.report(readings);
      }
      catch (error) { options.report([{ path: '', error: String(error) }]); }
      finally { control?.release(); control = undefined; running = undefined; schedule(reclaimed ? 1_000 : DATABASE_IDLE_MS); }
    })();
  };
  return {
    start() { if (!stopped) return; stopped = false; noteDatabaseActivity(); schedule(); },
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      control?.cancel();
      await running;
    },
  };
}
