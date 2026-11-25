import Database from 'better-sqlite3';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createDatabaseMaintenance, DATABASE_IDLE_MS } from './maintenance';
import { maintainDatabases, type MaintenanceReading } from './maintenance-worker';
import { noteDatabaseActivity } from './maintenance-activity';

const opens = vi.hoisted(() => new Map<string, number>());
vi.mock('better-sqlite3', async original => {
  const actual = await original<{ default: typeof Database }>();
  return { ...actual, default: new Proxy(actual.default, {
    construct(target, args) {
      const path = String(args[0]);
      opens.set(path, (opens.get(path) ?? 0) + 1);
      return Reflect.construct(target, args);
    },
  }) };
});

afterEach(() => { vi.useRealTimers(); });

it('opens each real legacy database once across repeated idle cycles', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'sqlite-legacy-idle-'));
  const targets = ['main.sqlite', 'search.sqlite'].map(name => {
    const path = join(directory, name), db = new Database(path);
    db.exec("CREATE TABLE keep(value TEXT); INSERT INTO keep VALUES ('intact')");
    expect(db.pragma('auto_vacuum', { simple: true })).toBe(0);
    db.close();
    const stat = statSync(path, { bigint: true });
    return { path, identity: `${stat.dev}:${stat.ino}` };
  });
  opens.clear();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const run = vi.fn(maintainDatabases);
  const report = vi.fn<(readings: MaintenanceReading[]) => void>();
  const maintenance = createDatabaseMaintenance({ idle: () => true, quiet: () => true, targets: () => targets, run, report });
  try {
    maintenance.start();
    await vi.advanceTimersByTimeAsync(DATABASE_IDLE_MS * 6);
    expect(run).toHaveBeenCalledOnce();
    expect(report.mock.calls[0][0].map(reading => reading.result?.state)).toEqual(['legacy', 'legacy']);
    for (const target of targets) expect(opens.get(target.path)).toBe(1);
    expect(noteDatabaseActivity()).toBeUndefined();
  } finally {
    await maintenance.stop();
    rmSync(directory, { recursive: true, force: true });
    opens.clear();
  }
});
