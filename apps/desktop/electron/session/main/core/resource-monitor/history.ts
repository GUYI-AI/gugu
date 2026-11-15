import Database from 'better-sqlite3';
import { sqlite } from '@main/db/client';
import { RESOURCE_HISTORY_LIMITS, RESOURCE_RECENT_WINDOW_MS, resourceTotals, type ResourceHistory, type ResourcePageSummary, type ResourcePoint, type ResourceSnapshot } from '@shared/resource-monitor';

const POINT_COLUMNS = 'id,timestamp,cpu,memory,run_id AS runId,long_frames AS longFrames,slow_interactions AS slowInteractions,style_layout_ms AS styleLayoutMs,page_interval_ms AS pageIntervalMs';

/** Local bounded history; SQLite reuses deleted pages. No timer or whole-history memory cache. */
export class ResourceHistoryStore {
  constructor(private readonly connection: Database.Database, private readonly limits = RESOURCE_HISTORY_LIMITS) {}

  append(snapshot: ResourceSnapshot): number {
    const json = JSON.stringify(snapshot);
    const bytes = Buffer.byteLength(json);
    if (bytes > this.limits.bytes) throw new Error('A resource sample exceeds the history byte limit');
    return this.connection.transaction(() => {
      const totals = resourceTotals(snapshot);
      const cpu = totals.cpuPercent ?? null;
      const memory = totals.memoryBytes ?? null;
      const page = snapshot.page;
      const id = Number(this.connection.prepare(`INSERT INTO resource_history(timestamp,run_id,cpu,memory,bytes,snapshot,long_frames,slow_interactions,style_layout_ms,page_interval_ms)
        VALUES (?,?,?,?,?,?,?,?,?,?)`).run(snapshot.timestamp, snapshot.runId ?? '', cpu, memory, bytes, json,
        page?.longFrames ?? null, page?.slowInteractions ?? null, page?.styleLayoutMs ?? null, page?.intervalMs ?? null).lastInsertRowid);
      this.connection.prepare(`DELETE FROM resource_history WHERE id <= (
        SELECT max(id) FROM (
          SELECT id,timestamp,row_number() OVER (ORDER BY id DESC) AS n,
            sum(bytes) OVER (ORDER BY id DESC) AS total FROM resource_history
        ) WHERE n > ? OR total > ? OR timestamp < ?
      )`).run(this.limits.points, this.limits.bytes, snapshot.timestamp - this.limits.ageMs);
      return id;
    })();
  }

  read(since = 0, until = Number.MAX_SAFE_INTEGER): ResourceHistory {
    const all = this.connection.prepare(`SELECT ${POINT_COLUMNS} FROM resource_history WHERE timestamp BETWEEN ? AND ? ORDER BY id`)
      .all(since, until) as ResourcePoint[];
    // Keep bucket maxima, not just every Nth point, so short CPU/memory spikes and stalls remain selectable.
    const stall = (p: ResourcePoint) => (p.styleLayoutMs ?? -1) / (p.pageIntervalMs || 1) + (p.longFrames ?? 0) * 1000;
    const points: ResourcePoint[] = [];
    const step = Math.max(1, Math.ceil(all.length / 299));
    for (let i = 0; i < all.length; i += step) {
      const bucket = all.slice(i, i + step);
      const cpu = bucket.reduce((a, b) => (b.cpu ?? -1) > (a.cpu ?? -1) ? b : a);
      const memory = bucket.reduce((a, b) => (b.memory ?? -1) > (a.memory ?? -1) ? b : a);
      const page = bucket.reduce((a, b) => stall(b) > stall(a) ? b : a);
      points.push(cpu, memory, ...(stall(page) >= 0 ? [page] : []));
    }
    if (all.length) points.push(all[0], all[all.length - 1]);
    const unique = [...new Map(points.map((p) => [p.id, p])).values()].sort((a, b) => a.id - b.id);
    const totals = this.connection.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM resource_history').get() as { count: number; bytes: number };
    const defined = (p: ResourcePoint) => Object.fromEntries(Object.entries(p).filter(([, v]) => v !== null)) as ResourcePoint;
    return { points: unique.map(defined), ...totals, limits: this.limits };
  }

  /** Page metrics of the samples recorded in the window ending at `now`; the page tiles and the external reading both show this sum. */
  recent(now: number, windowMs = RESOURCE_RECENT_WINDOW_MS): ResourcePageSummary {
    const row = this.connection.prepare(`SELECT count(long_frames) AS samples,coalesce(sum(long_frames),0) AS longFrames,
      coalesce(sum(slow_interactions),0) AS slowInteractions,sum(style_layout_ms) AS styleLayoutMs FROM resource_history WHERE timestamp > ?`)
      .get(now - windowMs) as { samples: number; longFrames: number; slowInteractions: number; styleLayoutMs: number | null };
    return { windowMs, samples: row.samples, longFrames: row.longFrames, slowInteractions: row.slowInteractions, ...(row.styleLayoutMs === null ? {} : { styleLayoutMs: Math.round(row.styleLayoutMs * 10) / 10 }) };
  }

  point(id: number): ResourceSnapshot | null {
    const row = this.connection.prepare('SELECT snapshot FROM resource_history WHERE id=?').get(id) as { snapshot: string } | undefined;
    return row ? JSON.parse(row.snapshot) as ResourceSnapshot : null;
  }

  clear(): void { this.connection.prepare('DELETE FROM resource_history').run(); }

  /** Stream raw rows from a WAL read snapshot; recording can continue on the writer connection. */
  async *export(): AsyncGenerator<string> {
    const reader = new Database(this.connection.name, { readonly: true, fileMustExist: true });
    try {
      reader.exec('BEGIN');
      const totals = reader.prepare('SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM resource_history').get();
      yield JSON.stringify({ format: 'gugu-resource-monitor-timeline/1', limits: this.limits, ...totals as object }).slice(0, -1) + ',"samples":[';
      let separator = '';
      for (const row of reader.prepare('SELECT snapshot FROM resource_history ORDER BY id').iterate() as Iterable<{ snapshot: string }>) {
        yield separator + row.snapshot;
        separator = ',';
      }
      yield ']}';
    } finally { reader.close(); }
  }
}
export const resourceHistory = new ResourceHistoryStore(sqlite);
