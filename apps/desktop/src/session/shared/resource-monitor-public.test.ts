import { describe, expect, it } from 'vitest';
import { resourceTotals, type ResourceSnapshot } from './resource-monitor';
import { publicResourcePoint, publicResourceReading } from './resource-monitor-public';

const snapshot: ResourceSnapshot = {
  timestamp: 5, cpuCount: 8, totalMemoryBytes: 16e9, runId: 'run', memoryMetric: 'footprint',
  app: { cpuPercent: 12, memoryBytes: 600 },
  appProcesses: [
    { pid: 1, type: 'Browser', cpu: 4, memory: 200 },
    { pid: 2, type: 'Tab', name: 'secret window', cpu: 7, memory: 300 },
    { pid: 3, type: 'Tab', memory: 100 },
  ],
  entries: [{ ptySessionId: 'p', projectId: 'proj', scopeId: 's', leafId: 'l', pid: 9, cpu: 1, memory: 50, title: 'ssh prod' }],
  processGroups: [
    { id: 'runtime:acp', kind: 'runtime', label: 'ACP', cpu: 2, memory: 70, processes: [{ pid: 20, ppid: 1, name: 'node /home/me/x', memory: 70 }] },
    { id: 'session:a', kind: 'session', label: 'Secret task', sessionId: 'a', cpu: 3, memory: 80, processes: [{ pid: 30, ppid: 1, name: 'claude', memory: 40 }, { pid: 31, ppid: 30, name: 'tsgo', memory: 40 }] },
  ],
  page: { intervalMs: 3000, longFrames: 1, blockingMs: 70, slowInteractions: 0, styleLayoutMs: 40 },
  recent: { windowMs: 60_000, samples: 20, longFrames: 4, slowInteractions: 1, styleLayoutMs: 300 },
  context: { windows: [{ id: 1, title: 'Private chat', focused: true, visible: true, minimized: false }, { id: 2, title: 'x', focused: false, visible: true, minimized: true }] },
};

describe('public resource reading', () => {
  it('shows the same totals as the monitor page', () => {
    const reading = publicResourceReading(snapshot);
    expect({ cpuPercent: reading.cpuPercent, memoryBytes: reading.memoryBytes }).toEqual(resourceTotals(snapshot));
    expect(reading).toMatchObject({
      memoryMetric: 'footprint',
      app: { Browser: { count: 1, cpuPercent: 4, memoryBytes: 200 }, Tab: { count: 2, cpuPercent: 7, memoryBytes: 400 } },
      services: { count: 1, memoryBytes: 70 }, sessions: { count: 2, memoryBytes: 80 }, terminals: { count: 1, memoryBytes: 50 },
      page: snapshot.page, recent: snapshot.recent,
      windows: { count: 2, visible: 1, focused: true },
    });
  });
  it('carries no titles, labels, ids, pids or commands', () => {
    const text = JSON.stringify(publicResourceReading(snapshot));
    for (const leak of ['secret', 'Secret', 'Private', 'ssh prod', '/home/me', 'claude', 'tsgo', 'proj', 'run', '"pid"']) expect(text).not.toContain(leak);
    expect(publicResourcePoint({ id: 3, runId: 'run', timestamp: 1, cpu: 2 })).toEqual({ timestamp: 1, cpu: 2 });
  });
  it('labels older samples as RSS', () => {
    expect(publicResourceReading({ ...snapshot, memoryMetric: undefined }).memoryMetric).toBe('rss');
  });
});
