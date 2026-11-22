// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it, vi } from 'vitest';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const toast = vi.hoisted(() => vi.fn());
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast }));
vi.mock('@/store/devicesCache', () => ({ readCachedDevices: () => [] }));
// This computer's market entry, as its App API answers it.
const api = vi.hoisted(() => ({ marketEntry: vi.fn() }));
vi.mock('@renderer/features/extensions/extensions-api', async (importOriginal) => ({
  ...await importOriginal<typeof import('@renderer/features/extensions/extensions-api')>(),
  extensionsApiOf: () => api,
}));

const { useAppDetailRequest } = await import('./use-app-detail-request');
const { installedExtensions } = await import('@renderer/features/extensions/installed-extensions');
const { queryClient } = await import('@/lib/replica');

async function request(installed: string[], market: Record<string, unknown> | null, page: { page?: 'manage' | 'market'; extensionId: string } = { extensionId: 'notes' }, hasSubject = false) {
  queryClient.clear();
  const onPage = vi.fn();
  const onSubject = vi.fn();
  const marketEntry = api.marketEntry.mockReset().mockImplementation(async () => (market ? { success: true, data: market } : { success: true, data: null }));
  installedExtensions.set(['local'], { extensions: installed.map((id) => ({ id })), invalid: [], variants: {} } as never);
  const host = { key: 'local' };
  function Probe() {
    useAppDetailRequest({ page, ready: true, host: host as never, hasSubject: () => hasSubject, onPage, onSubject, rootRef: { current: null } });
    return null;
  }
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Probe)));
  await act(async () => { await Promise.resolve(); });
  act(() => root.unmount());
  return { onPage, onSubject, marketEntry };
}

describe('gugu://app/<id> picks the page', () => {
  it('installed: its settings page, without asking the market', async () => {
    const { onPage, marketEntry } = await request(['notes'], null);
    expect(onPage).toHaveBeenCalledWith('manage');
    expect(marketEntry).not.toHaveBeenCalled();
  });

  it('not installed: the market page of what the market offers', async () => {
    const manifest = { id: 'notes' };
    const { onPage, onSubject } = await request([], { manifest, cloud: { version: '1.0.0' }, ref: { extensionId: 'notes', version: '1.0.0' } });
    expect(onSubject).toHaveBeenCalledWith({ manifest, cloud: { version: '1.0.0' }, installRef: { extensionId: 'notes', version: '1.0.0' } });
    expect(onPage).toHaveBeenCalledWith('market');
  });

  it('neither: says so, and opens nothing', async () => {
    toast.mockClear();
    const { onPage, onSubject } = await request([], null);
    expect(onPage).not.toHaveBeenCalled();
    expect(onSubject).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledOnce();
  });

  it('a market page come back to (back, a restart) reads only its subject', async () => {
    const manifest = { id: 'notes' };
    const { onPage, onSubject } = await request(['notes'], { manifest, cloud: { version: '1.0.0' }, ref: { extensionId: 'notes', version: '1.0.0' } }, { page: 'market', extensionId: 'notes' });
    expect(onSubject).toHaveBeenCalledOnce();
    expect(onPage).not.toHaveBeenCalled();
  });

  it('a page already drawn asks nothing', async () => {
    const { onPage, marketEntry } = await request([], null, { page: 'market', extensionId: 'notes' }, true);
    expect(marketEntry).not.toHaveBeenCalled();
    expect(onPage).not.toHaveBeenCalled();
  });
});
