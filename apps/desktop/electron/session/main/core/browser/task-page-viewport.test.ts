import { describe, expect, it, vi } from 'vitest';
import { TaskPageViewport } from '../../../../server/task-page-viewport';

describe('standalone layout zoom and restart', () => {
  it('reconstructs the same layout and raster dimensions whether saved zoom or resize arrives first', async () => {
    const send = vi.fn(async (_method: string, _params: Record<string, unknown>) => ({}));
    const first = new TaskPageViewport(send);
    await first.resize({ width: 400, height: 800, scale: 2 });
    await first.zoom(0.5);
    const before = send.mock.calls.slice(-2);
    send.mockClear();
    const restored = new TaskPageViewport(send);
    await restored.zoom(0.5);
    expect(send).not.toHaveBeenCalled();
    await restored.resize({ width: 400, height: 800, scale: 2 });
    expect(send.mock.calls).toEqual(before);
    expect(send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', { width: 800, height: 1600, deviceScaleFactor: 1, mobile: false });
    expect(send).toHaveBeenLastCalledWith('Emulation.setPageScaleFactor', { pageScaleFactor: 1 });
  });
  it('resizes using the saved layout zoom, and restores 100% without compounding prior dimensions', async () => {
    const send = vi.fn(async () => ({})), view = new TaskPageViewport(send);
    await view.zoom(2);
    await view.resize({ width: 600, height: 900, scale: 2 });
    expect(send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', { width: 300, height: 450, deviceScaleFactor: 4, mobile: false });
    await view.zoom(1);
    expect(send).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', { width: 600, height: 900, deviceScaleFactor: 2, mobile: false });
  });
  it('serializes viewport changes so a late older override cannot win', async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const send = vi.fn(async () => ({})).mockImplementationOnce(async () => { await blocked; return {}; });
    const view = new TaskPageViewport(send);
    const resize = view.resize({ width: 400, height: 800, scale: 1 });
    const zoom = view.zoom(0.5);
    await Promise.resolve(); await Promise.resolve();
    expect(send).toHaveBeenCalledTimes(1);
    release(); await Promise.all([resize, zoom, view.ready()]);
    expect(send.mock.calls.at(-2)).toEqual(['Emulation.setDeviceMetricsOverride', { width: 800, height: 1600, deviceScaleFactor: 0.5, mobile: false }]);
    for (const factor of [0, NaN, Infinity, 5.01]) expect(() => view.zoom(factor)).toThrow('Invalid browser zoom');
  });
});
