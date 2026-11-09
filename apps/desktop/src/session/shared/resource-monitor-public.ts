import { resourceTotals, type ResourceAppProcessType, type ResourcePoint, type ResourceSnapshot } from './resource-monitor';

/**
 * The one reading shown outside the monitor page — device actions (`perf.*`) — built from
 * the same recorded sample and totals the settings page shows. Numbers and fixed enums only: no window or session
 * titles, labels, ids, pids, commands or paths.
 */
export interface PublicResourceReading {
  timestamp: number;
  cpuCount: number;
  totalMemoryBytes: number;
  memoryMetric: 'rss' | 'footprint';
  cpuPercent?: number;
  memoryBytes?: number;
  app: Partial<Record<ResourceAppProcessType, PublicUsage>>;
  /** Helper processes the app starts for itself (runtimes, engines' shared services). */
  services: PublicUsage;
  sessions: PublicUsage;
  terminals: PublicUsage;
  page?: ResourceSnapshot['page'];
  recent?: ResourceSnapshot['recent'];
  windows: { count: number; visible: number; focused: boolean };
}
export interface PublicUsage { count: number; cpuPercent: number; memoryBytes: number }
export type PublicResourcePoint = Omit<ResourcePoint, 'id' | 'runId'>;

const usage = (): PublicUsage => ({ count: 0, cpuPercent: 0, memoryBytes: 0 });
const add = (target: PublicUsage, cpu: number | undefined, memory: number, count = 1) => {
  target.count += count; target.cpuPercent += cpu ?? 0; target.memoryBytes += memory;
};

export function publicResourceReading(snapshot: ResourceSnapshot): PublicResourceReading {
  const totals = resourceTotals(snapshot);
  const app: PublicResourceReading['app'] = {};
  for (const p of snapshot.appProcesses) add((app[p.type] ??= usage()), p.cpu, p.memory);
  const services = usage(), sessions = usage(), terminals = usage();
  for (const group of snapshot.processGroups ?? []) add(group.kind === 'runtime' ? services : sessions, group.cpu, group.memory, group.processes.length);
  for (const entry of snapshot.entries) add(terminals, entry.cpu, entry.memory);
  const windows = snapshot.context?.windows ?? [];
  return {
    timestamp: snapshot.timestamp,
    cpuCount: snapshot.cpuCount,
    totalMemoryBytes: snapshot.totalMemoryBytes,
    memoryMetric: snapshot.memoryMetric ?? 'rss',
    cpuPercent: totals.cpuPercent,
    memoryBytes: totals.memoryBytes,
    app, services, sessions, terminals,
    ...(snapshot.page ? { page: snapshot.page } : {}),
    ...(snapshot.recent ? { recent: snapshot.recent } : {}),
    windows: { count: windows.length, visible: windows.filter((w) => w.visible && !w.minimized).length, focused: windows.some((w) => w.focused) },
  };
}

export function publicResourcePoint({ id: _id, runId: _runId, ...point }: ResourcePoint): PublicResourcePoint {
  return point;
}
