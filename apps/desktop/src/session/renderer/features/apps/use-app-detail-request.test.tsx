// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@/store/devicesCache', () => ({ readCachedDevices: () => [] }));

const { useAppDetailRequest } = await import('./use-app-detail-request');

async function request(installed: string[], market: Record<string, unknown> | null) {
  const setDetail = vi.fn();
  const marketEntry = vi.fn(async () => (market ? { success: true, data: market } : { success: false, error: 'not in the market' }));
  const host = { key: 'local', store: { manifests: installed.map((id) => ({ id })), variants: {} }, api: { marketEntry } };
  function Probe() {
    useAppDetailRequest({ target: { kind: 'app-detail', extensionId: 'notes' }, ready: true, host: host as never, setDetail, detail: null, rootRef: { current: null } });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => { await Promise.resolve(); });
  act(() => root.unmount());
  return { setDetail, marketEntry };
}

describe('gugu://app/<id> picks the page', () => {
  it('installed: its settings page, without asking the market', async () => {
    const { setDetail, marketEntry } = await request(['notes'], null);
    expect(setDetail).toHaveBeenCalledWith({ page: 'manage', extensionId: 'notes' });
    expect(marketEntry).not.toHaveBeenCalled();
  });

  it('not installed: the market page of what the market offers', async () => {
    const manifest = { id: 'notes' };
    const { setDetail } = await request([], { manifest, cloud: { version: '1.0.0' }, ref: { extensionId: 'notes', version: '1.0.0' } });
    expect(setDetail).toHaveBeenCalledWith({ page: 'market', subject: { manifest, cloud: { version: '1.0.0' }, installRef: { extensionId: 'notes', version: '1.0.0' } } });
  });

  it('neither: says so, and opens nothing', async () => {
    toast.mockClear();
    const { setDetail } = await request([], null);
    expect(setDetail).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledOnce();
  });
});
