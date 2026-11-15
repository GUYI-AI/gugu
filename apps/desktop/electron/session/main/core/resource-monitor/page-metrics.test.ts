import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RendererMetrics } from '@shared/renderer-metrics';

const state = vi.hoisted(() => ({ windows: [] as unknown[], metrics: {} as Record<string, number> }));
vi.mock('electron', () => ({ webContents: { getAllWebContents: () => state.windows } }));
import { commitPageTotals, pageMetricsSince, readPageTotals, stopPageCounters } from './page-metrics';

function window(id = 1, pid = 40) {
  let attached = false;
  const debug = {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; }),
    once: vi.fn(),
    sendCommand: vi.fn(async (method: string) => method === 'Performance.getMetrics' ? { metrics: Object.entries(state.metrics).map(([name, value]) => ({ name, value })) } : {}),
  };
  return { id, debugger: debug, isDestroyed: () => false, getType: () => 'window', getURL: () => 'gugu-app://app/index.html', getOSProcessId: () => pid, once: vi.fn() };
}
const renderer = (pid: number, longFrames: number, slowInteractions: number, blockingMs = 0) =>
  ({ pid, source: 'main-window', frames: { longFrames, blockingMs, slowInteractions } }) as unknown as RendererMetrics;
const counters = (style: number, layout: number, count = 0) => {
  state.metrics = { RecalcStyleDuration: style, LayoutDuration: layout, RecalcStyleCount: count, LayoutCount: count, Nodes: 5000, JSEventListeners: 800, Other: 1 };
};

beforeEach(() => { stopPageCounters(); state.windows = []; vi.useFakeTimers(); vi.setSystemTime(0); });

describe('main-window page metrics', () => {
  it('reports the change since the last recorded sample, not since the last read', async () => {
    const w = window(); state.windows = [w]; counters(1.0, 0.5, 10);
    const first = await readPageTotals([renderer(40, 3, 1, 200)], true);
    expect(w.debugger.attach).toHaveBeenCalledWith('1.3');
    expect(pageMetricsSince(first)).toBeUndefined(); // nothing to difference against yet
    commitPageTotals(first);
    vi.setSystemTime(3000); counters(1.2, 0.55, 14);
    const extra = await readPageTotals([renderer(40, 5, 1, 260)], true);
    expect(pageMetricsSince(extra)).toEqual({ intervalMs: 3000, longFrames: 2, blockingMs: 60, slowInteractions: 0, styleLayoutMs: 250, styleRecalcs: 4, layouts: 4, nodes: 5000, listeners: 800 });
    // An unrecorded read (API, page) does not move the baseline.
    vi.setSystemTime(6000);
    const next = await readPageTotals([renderer(40, 5, 2, 260)], true);
    expect(pageMetricsSince(next)).toMatchObject({ intervalMs: 6000, longFrames: 2, slowInteractions: 1 });
  });

  it('reads zero at idle', async () => {
    state.windows = [window()]; counters(1, 1, 3);
    commitPageTotals(await readPageTotals([renderer(40, 3, 1)], true));
    vi.setSystemTime(3000);
    expect(pageMetricsSince(await readPageTotals([renderer(40, 3, 1)], true))).toMatchObject({ longFrames: 0, slowInteractions: 0, styleLayoutMs: 0 });
  });

  it('restarts the baseline when the window reloads into a new renderer', async () => {
    state.windows = [window()]; counters(1, 1);
    commitPageTotals(await readPageTotals([renderer(40, 30, 9)], true));
    expect(pageMetricsSince(await readPageTotals([renderer(41, 0, 0)], true))).toBeUndefined();
  });

  it('detaches and says why when the counters are switched off, keeping the frame counters', async () => {
    const w = window(); state.windows = [w]; counters(1, 1);
    commitPageTotals(await readPageTotals([renderer(40, 1, 0)], true));
    const off = await readPageTotals([renderer(40, 2, 0)], false);
    expect(w.debugger.detach).toHaveBeenCalled();
    expect(pageMetricsSince(off)).toEqual({ intervalMs: 0, longFrames: 1, blockingMs: 0, slowInteractions: 0, countersUnavailable: 'off' });
    commitPageTotals(off);
    expect(pageMetricsSince(await readPageTotals([renderer(40, 4, 0)], false))).toMatchObject({ longFrames: 2, countersUnavailable: 'off' });
  });

  it('marks a failed debugger read instead of throwing', async () => {
    const w = window(); w.debugger.attach.mockImplementation(() => { throw new Error('Another debugger is already attached'); }); state.windows = [w];
    expect(await readPageTotals([renderer(40, 0, 0)], true)).toMatchObject({ countersUnavailable: 'failed' });
    state.windows = [];
    expect(await readPageTotals([renderer(40, 0, 0)], true)).toMatchObject({ countersUnavailable: 'no-window' });
  });

  it('leaves a debugger someone else attached, and only turns off the domain it enabled', async () => {
    const w = window(); w.debugger.attach(); w.debugger.attach.mockClear(); state.windows = [w]; counters(1, 1);
    await readPageTotals([renderer(40, 0, 0)], true);
    expect(w.debugger.attach).not.toHaveBeenCalled();
    stopPageCounters();
    expect(w.debugger.detach).not.toHaveBeenCalled();
    expect(w.debugger.sendCommand).toHaveBeenCalledWith('Performance.disable');
  });

  it('does not stay attached when monitoring stops while a read is still waiting on the debugger', async () => {
    const w = window(); state.windows = [w]; counters(1, 1);
    let enable!: () => void;
    w.debugger.sendCommand.mockImplementationOnce(() => new Promise((resolve) => { enable = () => resolve({}); }));
    const reading = readPageTotals([renderer(40, 0, 0)], true);
    await vi.waitFor(() => expect(enable).toBeDefined());
    stopPageCounters();
    enable();
    expect(await reading).toMatchObject({ countersUnavailable: 'off' });
    expect(w.debugger.isAttached()).toBe(false);
    expect(w.debugger.sendCommand).not.toHaveBeenCalledWith('Performance.getMetrics');
  });
});
