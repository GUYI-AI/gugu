import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../../tests/support/awaitCondition';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The App page's readings where a read fails or cannot be asked: another machine offline draws what was read of it; a
// market read that failed is said with a retry, ❌ an endless skeleton; loading more asks one page and keeps the rows drawn.
const h = vi.hoisted(() => {
  const item = (id: string) => ({
    manifest: { id, name: `App ${id}`, version: '1.0.0', apiVersion: 25, defaultLocale: 'en', entry: 'index.html', contributes: { tabs: [{ name: 'main', title: id }] } },
    ref: { extensionId: id, version: '1.0.0' },
    cloud: {
      version: '1.0.0', bundleSha256: 'a'.repeat(64), bundleBytes: 10, apiVersion: 25, minAppVersion: '0.1.0', releaseNotes: '',
      publishedAt: '2026-10-01T00:00:00Z', firstPublishedAt: '2026-10-01T00:00:00Z', iconUrl: null, deprecated: null, compat: null,
      newerNeedsApp: null, source: { repo: 'r', path: 'p', commit: 'c' }, featured: false, firstRun: false,
    },
  });
  const page = (ids: string[], at: number, hasMore: boolean) => ({
    success: true,
    data: { extensions: ids.map(item), invalid: [], errorKind: null, error: null, total: 4, page: at, hasMore, fetchedAt: '2026-10-16T01:00:00.000Z' },
  });
  const answer = (data: unknown) => async (): Promise<{ success: boolean; data?: unknown; error?: string }> => ({ success: true, data });
  const manifest = (id: string) => ({ id, name: id, version: '1.0.0', apiVersion: 25, defaultLocale: 'en', entry: 'index.html', permissions: { capabilities: ['files:read'], network: [] }, contributes: { tabs: [{ name: 'main', title: id }] } });
  const api = {
    list: vi.fn(answer({ extensions: [manifest('notes')], invalid: [], icons: {}, disabled: [] })),
    variants: vi.fn(answer({ active: 'upstream', variants: [], behind: null })),
    revoked: vi.fn(answer({})),
    agentStatus: vi.fn(answer({})),
    marketUpdates: vi.fn(answer({ checkedAt: '2026-10-16T00:00:00.000Z', updates: {}, yanked: {}, deprecated: {} })),
    market: vi.fn(),
    marketRefresh: vi.fn(async () => ({ success: true, data: { outcome: 'unchanged', fetchedAt: '2026-10-16T01:00:00.000Z' } })),
    marketEntry: vi.fn(async () => ({ success: false, error: 'offline' })),
    setPermissionGranted: vi.fn(),
  };
  const host = { key: 'remote:x', online: true, remote: true };
  return { item, page, api, host };
});

vi.mock('@/lib/supabase', () => ({ chatDb: { rpc: async () => ({ data: [], error: null }) }, getCurrentAuthUserId: async () => 'test-account' }));
vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: {}, app: {} },
  rpcOn: () => ({ extensions: h.api }),
  events: { on: () => () => undefined },
  onMachineEvent: () => () => undefined,
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => vi.fn() }));
vi.mock('@renderer/features/extensions/register-extension-tabs', () => ({ registerInstalledExtensionTabs: vi.fn() }));
vi.mock('@renderer/features/extensions/panel/app-given-section', () => ({ AppGivenSection: () => null }));
vi.mock('@renderer/features/library/library-host', async () => ({
  useLibraryHost: () => ({
    extensions: { key: h.host.key, api: h.api, onEvent: () => () => undefined, local: !h.host.remote, pickFolder: vi.fn() },
    remote: h.host.remote ? { deviceLabel: 'Studio', online: h.host.online, lastSeenAt: null, hostKind: 'desktop' } : undefined,
  }),
}));

const { SessionLocalizationProvider } = await import('@renderer/localization/localization-provider');
const { ExtensionsSettingsCard } = await import('./ExtensionsSettingsCard');
const { appState } = await import('@renderer/lib/stores/app-state');
const { openAppsLocation } = await import('@renderer/features/apps/apps-location');

describe('the App page when a read fails or cannot be asked', () => {
  let dom: JSDOM;
  let root: Root;
  const doc = () => dom.window.document;
  const turn = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 0))));
  const click = (node: Element) => act(async () => void node.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
  const alert = () => doc().querySelector('[data-testid="extensions-market-panel"] [role="alert"]');
  const cards = () => [...doc().querySelectorAll('[data-testid="extensions-market-panel"] [data-testid^="extension-card-"]')]
    .map((node) => node.getAttribute('data-testid')!.replace('extension-card-', ''));

  async function open(renderInstalledApps?: (items: readonly { id: string }[]) => null) {
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(SessionLocalizationProvider, null,
        React.createElement(ExtensionsSettingsCard, renderInstalledApps ? { renderInstalledApps } : {}))));
    });
  }

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' });
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('localStorage', dom.window.localStorage);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    h.host.key = `remote:host-${Math.random()}`;
    h.host.online = true;
    h.host.remote = true;
    h.api.market.mockReset().mockResolvedValue(h.page(['one', 'two'], 0, false));
    h.api.revoked.mockReset().mockResolvedValue({ success: true, data: {} });
    // Where on the Apps page is app-wide (apps-location): every case starts on its first tab, nothing open.
    appState.navigation.updateViewParams('apps', () => ({}));
    appState.history.prune(() => true);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  it('another machine gone offline: its Apps read before stay listed (read-only), it is not asked again', async () => {
    // The installed Apps as the Installed sheet lists them (the card's inventory mode).
    let listed: string[] = [];
    const list = (items: readonly { id: string }[]) => { listed = items.map((item) => item.id); return null; };
    await open(list);
    await until('its Apps listed', () => listed, (ids) => ids.includes('notes'));
    const asked = h.api.list.mock.calls.length;
    h.host.online = false;
    await open(list);
    await turn();
    expect(listed).toContain('notes');
    expect(h.api.list).toHaveBeenCalledTimes(asked);
  });

  it('loading more asks only the next page; when it fails the rows drawn stay, the failure is said, and retry reads that page', async () => {
    // Scrolling to the foot asks for more: the sentinel is in view as soon as it is watched.
    vi.stubGlobal('IntersectionObserver', class {
      constructor(private readonly callback: (entries: { isIntersecting: boolean }[]) => void) {}
      observe() { this.callback([{ isIntersecting: true }]); }
      disconnect() {}
    });
    h.api.market.mockImplementation(async ({ page, query }: { page: number; query: string }) =>
      query === '' ? h.page(['one', 'two'], 0, false) : page === 0 ? h.page(['a', 'b'], 0, true) : { success: false, error: 'boom' });
    await open();
    // The search reaches the market from its own tab (the page opens on Agents).
    await click(doc().querySelector('[data-testid="extensions-section-market"]')!);
    const input = doc().querySelector('input[type="search"]') as HTMLInputElement;
    await act(async () => {
      // React loaded without a window (node), so it reads a typed value as old browsers do: on focus, then on a key.
      // (Its old-browser value watch is `attachEvent`, which this page does not have: nothing to watch with.)
      Object.assign(input, { attachEvent: () => true, detachEvent: () => undefined });
      input.dispatchEvent(new dom.window.FocusEvent('focusin', { bubbles: true }));
      Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, 'x');
      input.dispatchEvent(new dom.window.KeyboardEvent('keyup', { bubbles: true }));
    });
    await until('the search asked', () => h.api.market.mock.calls.filter(([args]) => args.query === 'x').length, (n) => n >= 1);
    await until('page 1 asked', () => h.api.market.mock.calls.filter(([args]) => args.query === 'x' && args.page === 1).length, (n) => n >= 1);
    await until('the failure said', alert, (node) => node !== null);
    await turn();
    expect(cards()).toEqual(['a', 'b']);
    // Page 0 was read once: loading more did not read it again.
    expect(h.api.market.mock.calls.filter(([args]) => args.query === 'x' && args.page === 0)).toHaveLength(1);
    h.api.market.mockImplementation(async ({ page, query }: { page: number; query: string }) =>
      query === '' ? h.page(['one', 'two'], 0, false) : page === 0 ? h.page(['a', 'b'], 0, true) : h.page(['c', 'd'], 1, false));
    await click(alert()!.querySelector('button')!);
    await until('the next page drawn', cards, (ids) => ids.length === 4);
    expect(alert()).toBeNull();
    expect(h.api.market.mock.calls.filter(([args]) => args.query === 'x' && args.page === 0)).toHaveLength(1);
  });

  it('a permission taken back, refused, and its list unreadable again: the switch goes back to what was read before', async () => {
    await open();
    // Its settings page, a place on the Apps page (as the Installed sheet and App links open it).
    await act(async () => openAppsLocation({ tab: 'agents', detail: { page: 'manage', extensionId: 'notes' } }));
    const row = () => doc().querySelector('[data-testid="app-permission-files:read"]');
    await until('its permission drawn', row, (node) => node !== null);
    expect(row()!.className).not.toContain('is-revoked');
    h.api.setPermissionGranted.mockResolvedValue({ success: false, error: 'refused' });
    h.api.revoked.mockResolvedValue({ success: false, error: 'host gone' } as never);
    await click(row()!.querySelector('button')!);
    await until('the refusal settled', () => h.api.revoked.mock.calls.length, (n) => n >= 2);
    await turn();
    expect(row()!.className).not.toContain('is-revoked');
  });
});
