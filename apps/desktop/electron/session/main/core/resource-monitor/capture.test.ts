import { writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
const tracing = vi.hoisted(() => ({ release: () => {}, file: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  webContents: { getAllWebContents: () => [] },
  contentTracing: {
    startRecording: async () => {},
    stopRecording: async (file: string) => { await new Promise<void>((resolve) => { tracing.release = resolve; }); writeFileSync(file, JSON.stringify({ traceEvents: [{ name: 'x' }] })); tracing.file = file; return file; },
  },
}));
import { recordTrace, summarizeTrace, type TraceEvent } from './capture';

const PID = 7;
const main = (name: string, ts: number, dur: number, args?: TraceEvent['args']): TraceEvent => ({ ph: 'X', pid: PID, tid: 1, name, ts, dur, args });
const frame = (id: number, functionName: string, url: string, parent?: number) => ({ id, parent, callFrame: { functionName, url, lineNumber: 9 } });

describe('summarizeTrace', () => {
  const events: TraceEvent[] = [
    { ph: 'M', pid: PID, tid: 1, name: 'thread_name', args: { name: 'CrRendererMain' } },
    { ph: 'M', pid: 99, tid: 1, name: 'thread_name', args: { name: 'CrRendererMain' } }, // another renderer: ignored
    main('ThreadControllerImpl::RunTask', 0, 120_000),
    main('UpdateLayoutTree', 10_000, 40_000, { elementCount: 3000 }),
    main('Layout', 60_000, 20_000),
    main('ThreadControllerImpl::RunTask', 200_000, 10_000), // short task: busy time only
    { ph: 'X', pid: 99, tid: 1, name: 'ThreadControllerImpl::RunTask', ts: 0, dur: 900_000 },
    { ph: 'P', pid: PID, name: 'Profile', ts: 0, args: { data: { startTime: 0 } } },
    { ph: 'P', pid: PID, name: 'ProfileChunk', ts: 1, args: { data: {
      cpuProfile: { nodes: [
        frame(1, '(root)', ''),
        frame(2, 'switchChat', 'gugu-app://app/assets/ChatPane-AbC123xY.js', 1),
        frame(3, 'reconcile', 'gugu-app://app/assets/vendor-react-QwErTy12.js', 2),
        frame(4, '(idle)', '', 1),
      ], samples: [3, 3, 3, 4] },
      timeDeltas: [85_000, 10_000, 10_000, 10_000],
    } } },
  ];

  it('reports long tasks with their style/layout split and the app function that ran them', () => {
    const summary = summarizeTrace(events, new Set([PID]), 5);
    expect(summary).toMatchObject({ seconds: 5, mainThreadBusyMs: 130, longTasks: 1, longTaskMs: 120 });
    expect(summary.tasks[0]).toMatchObject({ ms: 120, styleMs: 40, styleElements: 3000, layoutMs: 20 });
    // Vendor frames are skipped up the stack to the app's own bundle, named without hash or path.
    expect(summary.tasks[0].top[0].frame).toBe('switchChat@ChatPane:10');
    expect(summary.tasks[0].scriptMs).toBeGreaterThan(0);
  });

  it('reports nothing when the window was idle', () => {
    expect(summarizeTrace(events.filter((e) => e.name === 'thread_name'), new Set([PID]), 10)).toEqual({ seconds: 10, mainThreadBusyMs: 0, longTasks: 0, longTaskMs: 0, tasks: [] });
  });
});

describe('recordTrace', () => {
  it('runs one recording at a time, returns its events and deletes the raw trace', async () => {
    const first = recordTrace({}, 0, 'test');
    await expect(recordTrace({}, 0, 'test')).rejects.toThrow('in progress');
    await vi.waitFor(() => expect(tracing.release).not.toBe(undefined));
    await new Promise((resolve) => setTimeout(resolve, 5));
    tracing.release();
    await expect(first).resolves.toEqual([{ name: 'x' }]);
    expect(existsSync(tracing.file)).toBe(false);
    const second = recordTrace({}, 0, 'test');
    await new Promise((resolve) => setTimeout(resolve, 5));
    tracing.release();
    await expect(second).resolves.toHaveLength(1);
  });
});
