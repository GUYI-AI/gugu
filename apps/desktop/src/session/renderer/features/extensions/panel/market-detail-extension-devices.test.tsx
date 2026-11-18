// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../../tests/support/awaitCondition';
import { SessionLocalizationProvider } from '@renderer/localization/localization-provider';
import { translateSessionMessage } from '@renderer/localization/locale-store';
import { parseExtensionManifest } from '@shared/extensions/manifest';
import type { MarketListItem } from '@shared/extensions/market';
import { MarketDetailDialog } from './market-detail-dialog';
import { MarketExtensionDevices } from './market-detail-extension-devices';

const mocks = vi.hoisted(() => {
  const online = { id: 'studio', label: 'Studio', isOnline: true, directTerminal: false, lastSeenAt: null };
  const offline = { ...online, id: 'laptop', label: 'Laptop', isOnline: false };
  const current = { ...online, id: 'local', isCurrentMachine: true };
  const backup = { ...online, id: 'backup', label: 'Backup' };
  const api = {
    list: vi.fn(),
    marketEntry: vi.fn(),
    marketHistory: vi.fn(),
    installFromMarket: vi.fn(),
  };
  const store = { load: vi.fn(async () => {}), checkUpdates: vi.fn(async () => {}) };
  const backupApi = { ...api, list: vi.fn(), installFromMarket: vi.fn() };
  return { online, offline, current, backup, api, backupApi, store, toast: vi.fn(), offlineRead: vi.fn() };
});
vi.mock('@renderer/features/remote-hosts/remote-hosts-store', () => ({
  remoteHostsStore: {
    hosts: new Map([mocks.online, mocks.offline, mocks.current, mocks.backup].map((device) => [device.id, { device }])),
    start: () => () => {},
    cloudScope: () => null,
  },
}));
vi.mock('@renderer/features/library/library-host', () => ({
  machineLibraryHost: ({ deviceId }: { deviceId: string }) => ({
    extensions: {
      api: deviceId === 'studio' ? mocks.api : deviceId === 'backup' ? mocks.backupApi : { list: mocks.offlineRead },
      store: mocks.store,
    },
  }),
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: mocks.toast }));

const manifest = parseExtensionManifest({
  id: 'calendar', name: 'Calendar', version: '1.1.0', apiVersion: 25, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: 'Calendar' }] },
});
const item = {
  manifest,
  ref: { extensionId: manifest.id, version: manifest.version },
  cloud: { version: manifest.version, compat: null, newerNeedsApp: null },
} as MarketListItem;

describe('actions for other devices in Marketplace details', () => {
  let root: Root;
  let container: HTMLDivElement;
  let client: QueryClient;
  const row = (id: string) => document.querySelector<HTMLLIElement>(`[data-device-id="${id}"]`);
  const click = async (element: HTMLElement) => { await act(async () => element.click()); };
  async function installOnStudio() {
    await click(row('studio')!.querySelector<HTMLElement>('[data-slot="checkbox"]')!);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="market-detail-install-selected"]')!);
  }
  const show = async () => {
    await act(async () => root.render(
      <QueryClientProvider client={client}>
        <SessionLocalizationProvider>
          <MarketDetailDialog onClose={() => root.render(null)}>
            <MarketExtensionDevices item={item} />
          </MarketDetailDialog>
        </SessionLocalizationProvider>
      </QueryClientProvider>
    ));
    await click(document.querySelector<HTMLButtonElement>('[data-testid="market-detail-other-devices"]')!);
    await until('installation action available', () => !!row('studio')?.querySelector('[data-slot="checkbox"]'));
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    mocks.api.marketEntry.mockResolvedValue({ success: true, data: item });
    mocks.api.list.mockResolvedValue({ success: true, data: { extensions: [] } });
    mocks.api.installFromMarket.mockReset();
    mocks.backupApi.installFromMarket.mockReset();
    mocks.backupApi.list.mockResolvedValue({ success: true, data: { extensions: [manifest] } });
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
    vi.unstubAllGlobals();
  });

  it('checks new permissions on the selected device and updates only that device', async () => {
    const installed = { ...manifest, version: '1.0.0' };
    const next = { ...manifest, permissions: { capabilities: [], network: ['calendar.example'] } };
    mocks.api.list.mockResolvedValue({ success: true, data: { extensions: [installed] } });
    mocks.api.installFromMarket.mockImplementation(async ({ consent }: { consent: { kind: string } }) => {
      if (consent.kind === 'return') return { success: true, data: { outcome: 'ask', asks: true, ask: {
        manifest: next, manifestDigest: 'calendar-1.1-digest', installed, revokedPermissions: [],
      } } };
      mocks.api.list.mockResolvedValue({ success: true, data: { extensions: [next] } });
      return { success: true, data: { outcome: 'confirmed' } };
    });

    await show();
    expect(row('studio')?.textContent).toContain(translateSessionMessage('marketDetail.deviceUpdate', { version: '1.0.0' }));
    expect(row('laptop')?.closest('details')?.open).toBe(false);
    expect(row('laptop')?.querySelector('[data-slot="checkbox"]')).toBeNull();
    expect(row('local')).toBeNull();
    expect(mocks.offlineRead).not.toHaveBeenCalled();
    await installOnStudio();
    expect(mocks.api.installFromMarket).toHaveBeenCalledExactlyOnceWith({ ref: item.ref, consent: { kind: 'return' } });
    await until('permission confirmation shown', () => document.querySelector('[data-testid="market-detail-confirmation"]')?.textContent?.includes('calendar.example') === true);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="market-detail-confirm"]')!);
    expect(mocks.api.installFromMarket).toHaveBeenLastCalledWith({ ref: item.ref, consent: { kind: 'given', digest: 'calendar-1.1-digest' } });
    await until('updated version shown', () => row('studio')?.textContent?.includes('v1.1.0') === true && !row('studio')?.querySelector('[data-slot="checkbox"]'));
  });

  it('installs a selected batch independently and continues after the picker closes', async () => {
    let complete!: (result: unknown) => void;
    const prepared = new Promise((resolve) => { complete = resolve; });
    mocks.backupApi.list.mockResolvedValue({ success: true, data: { extensions: [] } });
    mocks.api.installFromMarket
      .mockReturnValueOnce(prepared)
      .mockResolvedValueOnce({ success: true, data: { outcome: 'confirmed' } });
    mocks.backupApi.installFromMarket.mockRejectedValue(new Error('device disconnected'));

    await show();
    await until('second device selectable', () => !!row('backup')?.querySelector('[data-slot="checkbox"]'));
    const selectAllText = translateSessionMessage('marketDetail.selectAll');
    const selectAll = [...document.querySelectorAll('button')].find((button) => button.textContent === selectAllText)!;
    await click(selectAll);
    const start = document.querySelector<HTMLButtonElement>('[data-testid="market-detail-install-selected"]')!;
    expect(start.textContent).toBe(translateSessionMessage('marketDetail.installSelected', { count: 2 }));
    await click(start);
    expect(mocks.api.installFromMarket).toHaveBeenCalledTimes(1);
    expect(mocks.backupApi.installFromMarket).toHaveBeenCalledTimes(1);
    await click(document.querySelector<HTMLButtonElement>('[data-testid="market-detail-other-devices"]')!);
    await act(async () => complete({
      success: true, data: { outcome: 'ask', asks: false, ask: {
        manifest, manifestDigest: 'batch-digest', revokedPermissions: [],
      } },
    }));
    await until('install finished in the background', () => mocks.api.installFromMarket.mock.calls.length === 2);
    expect(mocks.api.installFromMarket).toHaveBeenLastCalledWith({ ref: item.ref, consent: { kind: 'given', digest: 'batch-digest' } });
    expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: translateSessionMessage('extensions.installFailedOn', { machine: 'Backup' }),
    }));
  });

  it('reports the failed target in a toast and restores that row’s Install button', async () => {
    mocks.api.installFromMarket.mockRejectedValue(new Error('device disconnected'));
    await show();
    await installOnStudio();
    const title = translateSessionMessage('extensions.installFailedOn', { machine: 'Studio' });
    await until('failure toast sent', () => mocks.toast.mock.calls.some(([entry]) => entry.title === title));
    await until('failed device can be reselected', () => row('studio')?.querySelector('[data-slot="checkbox"]')?.getAttribute('aria-checked') === 'false');
    expect(document.querySelector<HTMLButtonElement>('[data-testid="market-detail-install-selected"]')?.disabled).toBe(true);
    expect(row('studio')?.textContent).not.toContain(title);
  });
});
