import { EventEmitter } from 'node:events';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ windows: [] as unknown[] }));
vi.mock('electron', () => ({ webContents: { getAllWebContents: () => state.windows } }));
import { acquireMonitorDebugger } from './debugger-lease';
import { recordTrace } from './record-trace';

function window(alreadyAttached = false) {
  let attached = alreadyAttached;
  const data = { events: [{ name: 'x' }], loss: false };
  const transport = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: vi.fn(() => { attached = true; }),
    detach: vi.fn(() => { attached = false; transport.emit('detach', {}, 'test'); }),
    sendCommand: vi.fn(async (method: string, _params?: unknown) => {
      if (method === 'Tracing.end') {
        transport.emit('message', {}, 'Tracing.dataCollected', { value: data.events });
        transport.emit('message', {}, 'Tracing.tracingComplete', { dataLossOccurred: data.loss });
      }
      return {};
    }),
  });
  const contents = { debugger: transport, isDestroyed: () => false, getType: () => 'window', getURL: () => 'gugu-app://app/index.html' } as unknown as WebContents;
  state.windows = [contents];
  return { contents, transport, data };
}

beforeEach(() => { state.windows = []; vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('JSON trace events on Electron 45', () => {
  it('returns decoded events, excludes concurrent recordings and releases the transport', async () => {
    const { transport } = window();
    const first = recordTrace({}, 10, 'test');
    await expect(recordTrace({}, 0, 'other')).rejects.toThrow('in progress');
    await vi.runAllTimersAsync();
    await expect(first).resolves.toEqual([{ name: 'x' }]);
    expect(transport.detach).toHaveBeenCalledOnce();
    expect(transport.listenerCount('message')).toBe(0);
    expect(transport.listenerCount('detach')).toBe(0);
    const next = recordTrace({}, 0, 'next');
    await vi.runAllTimersAsync();
    await expect(next).resolves.toEqual([{ name: 'x' }]);
  });

  it('passes category filters and memory dump triggers through the CDP schema', async () => {
    const { transport } = window();
    const dump = { triggers: [{ mode: 'background', periodic_interval_ms: 250 }] };
    const recording = recordTrace({ included_categories: ['disabled-by-default-memory-infra'], excluded_categories: ['*'], memory_dump_config: dump }, 0, 'memory');
    await vi.runAllTimersAsync();
    await recording;
    expect(transport.sendCommand).toHaveBeenCalledWith('Tracing.start', {
      transferMode: 'ReportEvents',
      traceConfig: { includedCategories: ['disabled-by-default-memory-infra'], excludedCategories: ['*'], memoryDumpConfig: dump },
    });
  });

  it('keeps the shared transport attached until counters and tracing have both released it', async () => {
    const { contents, transport } = window();
    const counters = acquireMonitorDebugger(contents);
    const recording = recordTrace({}, 10, 'test');
    counters();
    expect(transport.detach).not.toHaveBeenCalled();
    await vi.runAllTimersAsync();
    await recording;
    expect(transport.attach).toHaveBeenCalledOnce();
    expect(transport.detach).toHaveBeenCalledOnce();
  });

  it('leaves an externally attached debugger intact when recording finishes', async () => {
    const { transport } = window(true);
    const recording = recordTrace({}, 0, 'test');
    await vi.runAllTimersAsync();
    await recording;
    expect(transport.attach).not.toHaveBeenCalled();
    expect(transport.detach).not.toHaveBeenCalled();
    expect(transport.isAttached()).toBe(true);
  });

  it('does not end another trace when Tracing.start is rejected', async () => {
    const { transport } = window(true);
    transport.sendCommand.mockRejectedValueOnce(new Error('Tracing has already been started'));
    await expect(recordTrace({}, 0, 'test')).rejects.toThrow('already been started');
    expect(transport.sendCommand).not.toHaveBeenCalledWith('Tracing.end');
    expect(transport.detach).not.toHaveBeenCalled();
    const next = recordTrace({}, 0, 'next');
    await vi.runAllTimersAsync();
    await expect(next).resolves.toHaveLength(1);
  });

  it('fails promptly on debugger detach and allows a later recording', async () => {
    const { transport } = window();
    const recording = recordTrace({}, 1000, 'test');
    const failure = expect(recording).rejects.toThrow('debugger detached');
    await vi.advanceTimersByTimeAsync(1);
    transport.detach();
    await failure;
    expect(vi.getTimerCount()).toBe(0);
    const next = recordTrace({}, 0, 'next');
    await vi.runAllTimersAsync();
    await expect(next).resolves.toHaveLength(1);
  });

  it('reports lost trace data instead of returning a partial summary', async () => {
    const { data } = window(); data.loss = true;
    const recording = recordTrace({}, 0, 'test');
    const failure = expect(recording).rejects.toThrow('data was lost');
    await vi.runAllTimersAsync();
    await failure;
  });

  it('reports a missing main window and resets the recording guard', async () => {
    await expect(recordTrace({}, 0, 'test')).rejects.toThrow('no main window');
    window();
    const recording = recordTrace({}, 0, 'next');
    await vi.runAllTimersAsync();
    await expect(recording).resolves.toHaveLength(1);
  });
});
