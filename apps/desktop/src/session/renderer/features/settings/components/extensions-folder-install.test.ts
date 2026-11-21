// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { until } from '../../../../../../../../tests/support/awaitCondition';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const h = vi.hoisted(() => {
  const manifest = (version: string, network: string[] = [], capabilities = ['files:read']) => ({
    id: 'notes',
    name: 'Notes',
    version,
    apiVersion: 25, // inside vi.hoisted: runs before any import
    defaultLocale: 'en',
    entry: 'index.html',
    permissions: { capabilities, network },
    contributes: { tabs: [{ name: 'main', title: 'Notes' }] },
  });
  const answer = (data: unknown) => async () => ({ success: true, data });
  const offline = async () => ({ success: false, error: 'offline' });
  const api = {
    list: vi.fn(answer({ extensions: [manifest('1.0.0')], invalid: [], icons: {}, disabled: [] })),
    switchVariant: vi.fn(),
    marketListing: vi.fn(offline),
    marketHistory: vi.fn(answer([])),
    revoked: vi.fn(answer({ notes: ['files:read'] })),
    agentStatus: vi.fn(answer({})),
    marketUpdates: vi.fn(answer({ checkedAt: '2026-09-28T00:00:00.000Z', updates: {}, yanked: {}, deprecated: {} })),
    market: vi.fn(offline),
    marketRefresh: vi.fn(answer({ outcome: 'unchanged', fetchedAt: '2026-09-28T00:00:00.000Z' })),
    marketEntry: vi.fn(offline),
    installFromFolder: vi.fn(),
    installFromMarket: vi.fn(),
    uninstall: vi.fn(async () => ({ success: true })),
  };
  return { manifest, api, agentList: vi.fn(async (): Promise<unknown[]> => []), showConfirm: vi.fn(), pickFolder: vi.fn(async () => '/tmp/notes-next') };
});

vi.mock('@/lib/supabase', () => ({
  chatDb: { rpc: async () => ({ data: [], error: null }) },
  getCurrentAuthUserId: async () => 'test-account',
}));

vi.mock('@renderer/lib/ipc', () => ({
  rpc: { extensions: h.api, agents: { listIcons: async () => ({}) }, viewState: { save: vi.fn(async () => ({ success: true })) } },
  rpcOn: () => ({ agents: { list: async () => [], listManagement: h.agentList, listAgentInstallationStatus: async () => [] } }),
  events: { on: () => () => undefined },
  onMachineEvent: () => () => undefined,
}));
vi.mock('@renderer/lib/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: vi.fn() }) }));
vi.mock('@renderer/lib/modal/modal-provider', () => ({ useShowModal: () => h.showConfirm }));
vi.mock('@renderer/features/extensions/register-extension-tabs', () => ({ registerInstalledExtensionTabs: vi.fn() }));
// A row's 「给哪些 agent」 is the main renderer's editor, which reads the platform as it loads: not what these cells are about.
vi.mock('@renderer/features/extensions/panel/app-given-section', () => ({ AppGivenSection: () => null }));
vi.mock('@renderer/features/library/library-host', async () => {
  const extensions = {
    key: 'local',
    api: h.api,
    onEvent: () => () => undefined,
    local: true,
    pickFolder: h.pickFolder,
  };
  return {
    LOCAL_HOST_KEY: 'local',
    useLibraryHost: () => ({
      key: 'local',
      agents: { listManagement: h.agentList, listAgentInstallationStatus: async () => [] },
      extensions,
      remote: undefined,
    }),
  };
});

vi.mock('@renderer/features/extensions/panel/market-detail-agent', async () => {
  const { DialogHeader, DialogTitle } = await import('@renderer/lib/ui/dialog');
  return {
    MarketAgentDetail: ({ agentId }: { agentId: string }) =>
      React.createElement(DialogHeader, null,
        React.createElement(DialogTitle, null, React.createElement('span', { 'data-testid': 'chosen-agent-detail' }, agentId))),
  };
});

const { SessionLocalizationProvider } = await import('@renderer/localization/localization-provider');
const { translateSessionMessage } = await import('@renderer/localization/locale-store');
const { toast } = await import('@renderer/lib/hooks/use-toast');
const { ExtensionsSettingsCard } = await import('./ExtensionsSettingsCard');
const { queryClient: replicas, followRendererSession } = await import('@/lib/replica');
// The agents library is the account's (the market's Agents page reads it for the signed-in person).
followRendererSession('SIGNED_IN', 'test-account');

// What is installed, the market and an App's pages are replicas (kept for the run): each cell reads them anew, as a new
// renderer process would.
const MODELS = ['installedExtensions', 'marketUpdates', 'marketShelf', 'marketSearch', 'marketEntry', 'marketListing',
  'marketVersionHistory', 'extensionRevokedPermissions', 'extensionAgentStatus', 'extensionSettings', 'appPlaces', 'extensionAgentTools',
  'extensionAgentSkills', 'extensionDataBytes', 'managementAgents', 'agentInstallationStatus'];
const { appState } = await import('@renderer/lib/stores/app-state');
const { openAppsLocation } = await import('@renderer/features/apps/apps-location');
type InstalledItem = import('@renderer/features/extensions/installed/installed-item').InstalledItem;

// Where on the Apps page is app-wide (apps-location): every case starts on the Apps page's first tab, nothing open.
beforeEach(() => {
  for (const name of MODELS) replicas.removeQueries({ queryKey: [name] });
  appState.navigation.updateViewParams('apps', () => ({}));
  appState.history.prune(() => true);
});

// How this build refuses an App written for apiVersion 2, as list() hands it over (#6934).
const REFUSED = 'Invalid manifest:\n- apiVersion: apiVersion 2 is an older App interface; ask an agent to rewrite the App for apiVersion 25 as app_create writes Apps.';

/** An App's settings page, opened as the Installed sheet and App links open it: a place on the Apps page. */
async function openSettings(extensionId: string) {
  await act(async () => openAppsLocation({ tab: 'agents', detail: { page: 'manage', extensionId } }));
}

/** The card as the Installed sheet's Apps segment uses it: the installed Apps as items, drawn by the sheet. */
function inventory() {
  let items: readonly InstalledItem[] = [];
  const element = React.createElement(ExtensionsSettingsCard, {
    renderInstalledApps: (next: readonly InstalledItem[]) => { items = next; return null; },
    onOpenInstalledApp: () => {},
  });
  return { element, items: () => items };
}

describe('Marketplace installed inventory', () => {
  let dom: JSDOM;
  let root: Root;
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    dom.window.close();
  });

  // The workspace App has prompts a person can edit, so it needs a settings page: listed, with no switch or uninstall.
  it('the installed list holds the preinstalled workspace App too', async () => {
    const listed = h.api.list.getMockImplementation();
    const shipped = (id: string, name: string) => ({ ...h.manifest('0.2.51'), id, name, contributes: { tabs: [{ name: 'main', title: name }] } });
    h.api.list.mockResolvedValue({
      success: true,
      data: {
        extensions: [h.manifest('1.0.0'), shipped('workspace', '群文件夹'), shipped('searcher', 'Searcher')],
        invalid: [],
        icons: {},
        disabled: [],
        origins: { workspace: 'preinstalled' },
      },
    } as never);
    try {
      const sheet = inventory();
      await act(async () => {
        root.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(SessionLocalizationProvider, null, sheet.element)));
      });
      await settle();
      expect(sheet.items().map((item) => item.id)).toEqual(expect.arrayContaining(['notes', 'searcher', 'workspace']));
      // One gugu ships cannot be broken from here: no switch or uninstall in the sheet, and on its settings page no switch,
      // page switch, revoke, clear, uninstall or agents editor.
      const workspace = sheet.items().find((item) => item.id === 'workspace')!;
      expect([workspace.setEnabled, workspace.remove]).toEqual([undefined, undefined]);
      act(() => root.unmount());
      root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
      await openSettings('workspace');
      await act(async () => {
        root.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard))));
      });
      await settle();
      const doc = dom.window.document;
      expect(doc.querySelector('[data-testid="app-manage-page"][data-extension-id="workspace"]')).not.toBeNull();
      expect(doc.querySelector('[data-testid="app-manage-page"] [role="switch"]')).toBeNull();
      for (const absent of ['app-manage-uninstall', 'app-manage-data', 'app-manage-pin']) expect(doc.querySelector(`[data-testid="${absent}"]`), absent).toBeNull();
      expect(doc.querySelector('[data-testid="app-manage-permissions"]')?.textContent).not.toContain(translateSessionMessage('extensions.revoke'));
    } finally {
      h.api.list.mockImplementation(listed!);
    }
  });

  // L11 复核 60: an installed folder this build cannot read (every v1 / v2 App once apiVersion 3 ships) sat in the list
  // with no way to remove it. It is an item of the sheet, named by its folder, removed by its folder name.
  it('an installed folder this build cannot read: listed by its folder name, and removing it uninstalls that folder', async () => {
    const listed = h.api.list.getMockImplementation();
    h.api.list.mockResolvedValue({
      success: true,
      data: { extensions: [h.manifest('1.0.0')], invalid: [{ dirName: 'old-notes', reason: REFUSED }], icons: {}, disabled: [] },
    });
    try {
      const sheet = inventory();
      await act(async () => {
        root.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(SessionLocalizationProvider, null, sheet.element)));
      });
      await settle();
      const unreadable = sheet.items().find((item) => item.id === 'old-notes')!;
      expect(unreadable.name).toBe('old-notes');
      h.api.list.mockResolvedValue({ success: true, data: { extensions: [h.manifest('1.0.0')], invalid: [], icons: {}, disabled: [] } });
      await act(async () => unreadable.remove!());
      expect(h.api.uninstall).toHaveBeenCalledWith({ extensionId: 'old-notes', lastAnywhere: true });
    } finally {
      h.api.list.mockImplementation(listed!);
    }
  });

  // L11 复核 60 补看: a machine picked in the device picker that cannot be reached rejects instead of answering — the
  // person is told it failed, as when it answers no. Control (b93c87469d): the rejection went nowhere, no toast.
  it('Uninstall of an unreadable folder on a machine that cannot be reached says it failed', async () => {
    const listed = h.api.list.getMockImplementation();
    h.api.list.mockResolvedValue({
      success: true,
      data: { extensions: [h.manifest('1.0.0')], invalid: [{ dirName: 'old-notes', reason: REFUSED }], icons: {}, disabled: [] },
    });
    h.api.uninstall.mockRejectedValueOnce(new Error('device offline'));
    try {
      const sheet = inventory();
      await act(async () => {
        root.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(SessionLocalizationProvider, null, sheet.element)));
      });
      await settle();
      const unreadable = sheet.items().find((item) => item.id === 'old-notes')!;
      await act(async () => { await expect(unreadable.remove!()).rejects.toThrow(); });
      // One uninstall for every App (L11 64): the failure reads as it does for a readable one — the words, and Retry.
      expect(vi.mocked(toast)).toHaveBeenCalledWith(expect.objectContaining({
        title: translateSessionMessage('extensions.uninstallFailed'),
        description: 'device offline',
        tier: 'error',
        action: expect.objectContaining({ label: translateSessionMessage('extensions.retry') }),
      }));
    } finally {
      h.api.list.mockImplementation(listed!);
    }
  });
});

// The sheet's 「这版改了什么」 and 「代码在哪」 are those of the version being installed, as main hands them back with what it
// would ask (installFromMarket `consent: return`) — main holds that version's row. Neither the page on screen (here 1.0.0, read before the update check)
// nor the market's current version (here 3.0.0: installing an older one from the history) is that version: matched against
// either, both lines were dropped (A/B 10-07; 复核 96 R3). 2.0.0 asks for a new host, so the sheet opens.
describe('Installing one version from the market: the sheet speaks of that version', () => {
  let dom: JSDOM;
  let root: Root;
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
  const source = { repo: 'shuxueshuxue/promo-skills', path: '.', commit: '6f46446' + 'a'.repeat(33) };
  const cloudOf = (version: string, releaseNotes: string) => ({
    version, bundleSha256: 'a'.repeat(64), bundleBytes: 10, apiVersion: 25, minAppVersion: '0.2.40', releaseNotes,
    publishedAt: '2026-10-07T00:00:00Z', firstPublishedAt: '2026-10-07T00:00:00Z', firstRun: false, iconUrl: null, deprecated: null, compat: null, newerNeedsApp: null, source,
  });
  const entryOf = (version: string, releaseNotes: string) => ({
    manifest: h.manifest(version, version === '2.0.0' ? ['api.example.com'] : []),
    ref: { extensionId: 'notes', version },
    cloud: cloudOf(version, releaseNotes),
  });
  const saved = { market: h.api.market.getMockImplementation(), marketEntry: h.api.marketEntry.getMockImplementation(), marketUpdates: h.api.marketUpdates.getMockImplementation() };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    vi.stubGlobal('Event', dom.window.Event);
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: [entryOf('1.0.0', 'the old notes')], invalid: [], errorKind: null, error: null, total: 1, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    h.api.marketEntry.mockResolvedValue({ success: true, data: entryOf('3.0.0', 'what 3.0.0 changed') } as never);
    h.api.marketUpdates.mockResolvedValue({
      success: true,
      data: { checkedAt: '2026-10-07T00:00:00.000Z', updates: { notes: { version: '2.0.0', releaseNotes: 'what 2.0.0 changed' } }, yanked: {}, deprecated: {} },
    } as never);
    (h.api as Record<string, unknown>).installFromMarket = vi.fn(async () => ({
      success: true,
      data: {
        installed: false, outcome: 'ask', id: 'notes', name: 'Notes', version: '2.0.0', asks: true,
        ask: {
          manifest: h.manifest('2.0.0', ['api.example.com']), manifestDigest: 'digest-2', installed: h.manifest('1.0.0'),
          revokedPermissions: ['files:read'], market: { source, releaseNotes: 'what 2.0.0 changed' },
        },
      },
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    h.api.market.mockImplementation(saved.market!);
    h.api.marketEntry.mockImplementation(saved.marketEntry!);
    h.api.marketUpdates.mockImplementation(saved.marketUpdates!);
    dom.window.close();
  });

  it('the sheet says what the installed version changed and that it came from the market', async () => {
    const sheet = inventory();
    await act(async () => {
      root.render(React.createElement(QueryClientProvider, { client: new QueryClient() }, React.createElement(SessionLocalizationProvider, null, sheet.element)));
    });
    await until('the update is offered', () => sheet.items().find((item) => item.id === 'notes')?.update !== undefined);
    // 有新版的那一项带「更新」(#7059 一个按钮走完一生)。
    void Promise.resolve(sheet.items().find((item) => item.id === 'notes')!.update!()).catch(() => {});
    await settle();
    expect(h.showConfirm).toHaveBeenCalledOnce();
    const { description } = h.showConfirm.mock.calls[0][0] as { description: string };
    expect(description).toContain('what 2.0.0 changed');
    expect(description).not.toContain('the old notes');
    expect(description).not.toContain('what 3.0.0 changed');
    expect(description).toContain(translateSessionMessage('extensions.consentFromMarket'));
    expect(description).not.toContain('shuxueshuxue/promo-skills');
    expect(description).toContain('api.example.com');
  });
});

describe('Desktop marketplace tabs and app details', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  const settle = () => act(async () => void (await new Promise((resolve) => setTimeout(resolve, 30))));
  const source = { repo: 'OpenDCAI/gugu', path: 'extensions/x', commit: '6f46446' + 'a'.repeat(33) };
  const app = (id: string, categories: string[], network: string[] = []) => ({
    manifest: { ...h.manifest('1.0.0', network, []), id, name: `App ${id}`, categories, subtitle: `${id} 的一句话` },
    ref: { extensionId: id, version: '1.0.0' },
    cloud: {
      version: '1.0.0', bundleSha256: 'a'.repeat(64), bundleBytes: 10, apiVersion: 25, minAppVersion: '0.2.40', releaseNotes: '',
      publishedAt: '2026-10-07T00:00:00Z', firstPublishedAt: '2026-10-07T00:00:00Z', firstRun: false, iconUrl: null, deprecated: null, compat: null, newerNeedsApp: null, source, featured: id === 'pomo',
    },
  });
  const listing = [app('arxiv', ['research'], ['export.arxiv.org']), app('pomo', ['productivity']), app('trace', ['developer'])];
  const saved = { market: h.api.market.getMockImplementation(), history: h.api.marketHistory.getMockImplementation() };

  beforeEach(() => {
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    vi.stubGlobal('window', dom.window);
    vi.stubGlobal('document', dom.window.document);
    vi.stubGlobal('HTMLElement', dom.window.HTMLElement);
    for (const key of ['Element', 'Event', 'Node', 'MutationObserver', 'HTMLButtonElement', 'CustomEvent', 'navigator'] as const) {
      vi.stubGlobal(key, dom.window[key]);
    }
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    root = createRoot(dom.window.document.getElementById('root') as HTMLDivElement);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.agentList.mockResolvedValue([]);
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: listing, invalid: [], errorKind: null, error: null, total: 3, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    (h.api as Record<string, unknown>).marketListing = vi.fn(async () => ({ success: true, data: { about: { en: 'About.' }, screenshots: ['https://dl.example/default.png'] } }));
    (h.api as Record<string, unknown>).marketHistory = vi.fn(async () => ({ success: true, data: [] }));
    // Main reads the unpacked package and hands back what it would ask (`return`); `given` installs it.
    (h.api as Record<string, unknown>).installFromMarket = vi.fn(async ({ ref, consent }: { ref: { extensionId: string }; consent?: { kind: string } }) => {
      const entry = listing.find((item) => item.manifest.id === ref.extensionId)!;
      if (consent?.kind === 'given') return { success: true, data: { installed: true, outcome: 'confirmed', id: ref.extensionId } };
      return {
        success: true,
        data: {
          installed: false, outcome: 'ask', id: ref.extensionId, name: entry.manifest.name, version: '1.0.0',
          asks: entry.manifest.permissions.network.length > 0,
          ask: { manifest: entry.manifest, manifestDigest: `digest-${ref.extensionId}`, revokedPermissions: [], market: { source, releaseNotes: '' } },
        },
      };
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    h.api.market.mockImplementation(saved.market!);
    h.api.marketListing = vi.fn(async () => ({ success: false, error: 'offline' }));
    h.api.marketHistory.mockImplementation(saved.history!);
    queryClient.clear();
    dom.window.close();
  });

  const page = () =>
    React.createElement(
      QueryClientProvider,
      { client: queryClient },
      React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard))
    );
  const render = async (tab: 'agents' | 'market' = 'market') => {
    await act(async () => {
      root.render(page());
    });
    await settle();
    if (tab === 'market') await press('[data-testid="extensions-section-market"]');
  };
  const press = async (selector: string) => {
    const node = dom.window.document.querySelector(selector) as HTMLElement | null;
    expect(node, selector).not.toBeNull();
    await act(async () => void node!.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })));
    await settle();
  };

  it('opens the same assistant detail from both market pages without an install button on the card', async () => {
    const assistant = app('gugu-assistant', ['other']);
    const extensions = [...listing, assistant];
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions, invalid: [], errorKind: null, error: null, total: extensions.length, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    h.agentList.mockResolvedValue([
      {
        id: 'claude', name: 'Claude Code', publisher: 'Anthropic', description: 'CLI', reading: 'installed',
        status: 'available', installations: [], used: { kind: 'auto' }, installOptions: [],
        version: '1.0.0', capabilities: { hostDependency: { updates: { kind: 'none' } } },
      },
      { id: 'kilocode', name: 'Kilo', publisher: '开源', description: 'CLI', reading: 'not-detected' },
    ]);
    await render('agents');
    const document = dom.window.document;
    const card = (id: string) => document.querySelector(`[data-testid="agent-market-card-${id}"], [data-testid="featured-agent-card-${id}"]`);
    expect(card('claude')?.textContent).toContain(translateSessionMessage('extensions.marketPublisher', { name: 'Anthropic' }));
    expect(card('claude')?.textContent).toContain(translateSessionMessage('extensions.installedMark'));
    expect(card('kilocode')?.textContent).not.toContain(translateSessionMessage('extensions.installedMark'));
    expect(card('kilocode')?.querySelector('button')).toBeNull();
    expect(document.querySelector('[data-testid="featured-agent-card-claude"]')).not.toBeNull();
    const nextBatch = [...document.querySelectorAll('button')].find((button) =>
      button.textContent?.trim() === translateSessionMessage('extensions.marketNextBatch')
    );
    expect(nextBatch).toBeDefined();
    await act(async () => nextBatch!.click());
    expect(document.querySelector('[data-testid="featured-agent-card-kilocode"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="featured-agent-card-claude"]')).toBeNull();
    expect(document.querySelector('[data-testid="agent-market-card-kilocode"]')).toBeNull();
    await press('[data-testid="featured-agent-card-kilocode"]');
    expect(document.querySelector('[data-testid="chosen-agent-detail"]')?.textContent).toBe('kilocode');
    await press('[data-testid="market-detail-dialog"] [data-slot="dialog-close"]');
    await press('[data-testid="agent-market-chip-general"]');
    expect(card('claude')).toBeNull();
    // From the agents' page the assistant's market page is the whole page; from the Apps list it sits beside the list.
    await press('[data-testid="extension-card-gugu-assistant"]');
    expect(document.querySelector<HTMLElement>('[data-testid="app-product-page"]')?.dataset.extensionId).toBe('gugu-assistant');
    expect(document.querySelector('[data-testid="extensions-market-panel"]')).toBeNull();
    await press('[data-testid="app-product-back"]');
    await press('[data-testid="extensions-section-market"]');
    await press('[data-testid="extension-card-gugu-assistant"]');
    expect(document.querySelector<HTMLElement>('[data-testid="extensions-market-panel"] [data-testid="app-product-page"]')?.dataset.extensionId).toBe('gugu-assistant');
    await press('[data-testid="app-product-back"]');
    // 「已安装」 opens the Installed sheet: a place on the Apps page, on its first segment.
    await press('[data-testid="extensions-open-installed"]');
    expect(appState.navigation.viewParamsStore.apps?.location?.installed).toEqual({ section: 'agents', deviceId: undefined });
  });

  it('searches the current catalog with the same search field', async () => {
    h.agentList.mockResolvedValue([
      { id: 'claude', name: 'Claude Code', description: 'CLI', reading: 'installed' },
      { id: 'kilocode', name: 'Kilo', description: 'CLI', reading: 'not-detected' },
    ]);
    await render('agents');
    const document = dom.window.document;
    const searchFor = async (value: string) => {
      const input = document.querySelector<HTMLInputElement>('input[type="search"]')!;
      await act(async () => {
        Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value')!.set!.call(input, value);
        input.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
      });
    };
    await searchFor('Kilo');
    expect(document.querySelector('[data-testid="agent-market-card-claude"]')).toBeNull();
    expect(document.querySelector('[data-testid="agent-market-card-kilocode"]')).not.toBeNull();

    await press('[data-testid="extensions-section-market"]');
    const results = [listing[0]!];
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: results, invalid: [], errorKind: null, error: null, total: 1, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    await searchFor('arxiv');
    await until('only matching extension cards are drawn', () =>
      document.querySelector('[data-testid="extensions-market-section-results"] [data-testid="extension-card-arxiv"]') !== null
      && document.querySelector('[data-testid="extension-card-pomo"]') === null
    );
    expect(h.api.market).toHaveBeenCalledWith({ page: 0, query: 'arxiv' });
    expect(document.querySelector('[data-testid="extension-card-arxiv"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="extension-card-pomo"]')).toBeNull();
  });

  it('shows eligible featured apps, and only supported sorting and category choices', async () => {
    await render();
    const document = dom.window.document;
    const chips = [...document.querySelectorAll('[data-testid^="extensions-market-chip-"]')].map((node) =>
      node.getAttribute('data-testid')!.replace('extensions-market-chip-', '')
    );
    const tiles = () => [...document.querySelectorAll('[data-testid^="extension-card-"]')].map((node) => node.getAttribute('data-testid'));
    expect(chips).toEqual(['all', 'research', 'productivity', 'developer']);
    expect(tiles()).toEqual(['extension-card-arxiv', 'extension-card-trace']);
    expect(document.querySelector('[data-testid="extensions-market-sort-newest"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="extensions-market-sort-popular"]')).toBeNull();
    expect(document.querySelector('[data-testid="featured-extension-card-pomo"]')).not.toBeNull();
    expect(document.body.textContent).not.toMatch(/Install from folder|装本地文件夹/);
    await press('[data-testid="extensions-market-chip-developer"]');
    expect(tiles()).toEqual(['extension-card-trace']);
  });

  it('reads every catalog page for category browsing', async () => {
    const entries = Array.from({ length: 14 }, (_, i) => app(`app-${i}`, ['productivity']));
    h.api.market.mockImplementation((async ({ page }: { page: number }) => ({ success: true, data: {
      extensions: entries.slice(page * 12, (page + 1) * 12), invalid: [], errorKind: null, error: null,
      total: 14, page, hasMore: page === 0, fetchedAt: null,
    } })) as never);
    await render();
    expect(h.api.market).toHaveBeenCalledWith({ page: 1, query: '' });
    await press('[data-testid="extensions-market-chip-productivity"]');
    expect(dom.window.document.querySelectorAll('[data-testid^="extension-card-"]')).toHaveLength(14);
  });

  it('第一次装、什么权限都不要的:产品页头上点「安装」就装,不弹框', async () => {
    await render();
    await press('[data-testid="featured-extension-card-pomo"]');
    await press('[data-testid="app-product-action"]');
    expect(h.showConfirm).not.toHaveBeenCalled();
    expect((h.api as unknown as { installFromMarket: ReturnType<typeof vi.fn> }).installFromMarket).toHaveBeenLastCalledWith({
      ref: { extensionId: 'pomo', version: '1.0.0' },
      consent: { kind: 'given', digest: 'digest-pomo' },
    });
  });

  it('要了权限的(这里是联网):照旧先问,点头之前不装', async () => {
    await render();
    await press('[data-testid="extension-card-arxiv"]');
    await press('[data-testid="app-product-action"]');
    const installFromMarket = (h.api as unknown as { installFromMarket: ReturnType<typeof vi.fn> }).installFromMarket;
    expect(installFromMarket.mock.calls.map(([args]) => (args as { consent?: { kind: string } }).consent?.kind)).toEqual(['return']);
    expect(h.showConfirm).toHaveBeenCalledOnce();
    await act(async () => void (h.showConfirm.mock.calls[0][0] as { onSuccess: () => void }).onSuccess());
    expect(installFromMarket.mock.calls.map(([args]) => (args as { consent?: { kind: string } }).consent?.kind)).toEqual(['return', 'given']);
    expect(dom.window.document.querySelector<HTMLElement>('[data-testid="app-product-page"]')?.dataset.extensionId).toBe('arxiv');
  });

  it('opens compatibility and upgrade requirements in extension details', async () => {
    const blocked = app('arxiv', ['research']);
    const newer = app('trace', ['developer']);
    const entries = [
      { ...blocked, cloud: { ...blocked.cloud, compat: { reason: 'needs-newer-app' as const, gate: 'app' as const, minAppVersion: '9.0.0' } } },
      listing[1]!,
      { ...newer, cloud: { ...newer.cloud, newerNeedsApp: '2.0.0' } },
    ];
    h.api.market.mockResolvedValue({
      success: true,
      data: { extensions: entries, invalid: [], errorKind: null, error: null, total: 3, page: 0, hasMore: false, fetchedAt: null },
    } as never);
    await render();
    const document = dom.window.document;
    const sub = (id: string) => document.querySelector(`[data-testid="extension-card-${id}"] .mk-market-card-description`)?.textContent;
    // 简介是「arxiv 的一句话」,没写副标题:名字下面就是它,❌ 写状态或类别。
    expect(sub('arxiv')).toBe('arxiv 的一句话');
    expect(sub('trace')).toBe('trace 的一句话');
    expect(document.querySelector('[data-testid="extension-card-arxiv"] button')).toBeNull();
    await press('[data-testid="extension-card-arxiv"]');
    expect(document.querySelector('[data-testid="app-product-page"]')?.textContent).toContain(
      translateSessionMessage('extensions.needsNewerApp', { version: '9.0.0' })
    );
    // The next App from the list beside the page, without going back first.
    await press('[data-testid="extension-card-trace"]');
    expect(document.querySelector('[data-testid="app-product-newer-needs-app"]')?.textContent).toBe(
      translateSessionMessage('extensions.newerNeedsApp', { version: '2.0.0' })
    );
  });

  // 10-16 实测：市场上 office 0.1.1、预装的 0.1.0 —— 产品页「Update to v0.1.1」,一按就是「another package cannot replace it」。
  // 预装的跟着咕咕更新:货架上新一点的那版对它不算更新。对照：同一个 App 不是预装的，照常出「更新到」。
  for (const [origins, offered] of [[{ pomo: 'preinstalled' }, false], [{ pomo: 'market' }, true]] as const) {
    it(`货架上有比装着的新一版：${'pomo' in origins && origins.pomo === 'preinstalled' ? '预装的不出「更新到」' : '不是预装的照常出「更新到」(对照)'}`, async () => {
      const here = app('pomo', ['productivity']);
      const newer = { ...here, manifest: { ...here.manifest, version: '1.1.0' }, ref: { extensionId: 'pomo', version: '1.1.0' }, cloud: { ...here.cloud, version: '1.1.0' } };
      h.api.market.mockResolvedValue({
        success: true,
        data: { extensions: [newer], invalid: [], errorKind: null, error: null, total: 1, page: 0, hasMore: false, fetchedAt: null },
      } as never);
      h.api.list.mockResolvedValueOnce({ success: true, data: { extensions: [here.manifest], invalid: [], icons: {}, disabled: [], origins } } as never);
      await render();
      await press('[data-testid="featured-extension-card-pomo"]');
      const action = dom.window.document.querySelector('[data-testid="app-product-action"]')?.textContent ?? null;
      // The product page is drawn either way (a missing button would make the arm without an offer pass on nothing).
      expect(action).not.toBeNull();
      expect(action === translateSessionMessage('extensions.updateTo', { version: '1.1.0' })).toBe(offered);
    });
  }

  it('an installed App\'s market page leads to its settings page, where it is uninstalled', async () => {
    const listed = h.api.list.getMockImplementation();
    const here = app('pomo', ['productivity']);
    h.api.list.mockResolvedValue({ success: true, data: { extensions: [here.manifest], invalid: [], icons: {}, disabled: [], origins: { pomo: 'market' } } } as never);
    try {
      await render();
      await press('[data-testid="featured-extension-card-pomo"]');
      await press('[data-testid="app-product-manage"]');
      expect(dom.window.document.querySelector('[data-testid="extensions-manage"]')).not.toBeNull();
    } finally {
      h.api.list.mockImplementation(listed!);
    }
  });

  it('opens an App beside the Marketplace list, switches from the list and goes back to the grid', async () => {
    await render();
    const document = dom.window.document;
    const page = () => document.querySelector<HTMLElement>('[data-testid="extensions-market-panel"] [data-testid="app-product-page"]');
    await press('[data-testid="extension-card-trace"]');
    expect(page()?.dataset.extensionId).toBe('trace');
    expect(document.querySelector('[data-testid="extension-card-trace"]')?.getAttribute('aria-current')).toBe('true');
    // Beside a page the list is one list: the featured row's Apps are in it.
    expect(document.querySelector('[data-testid="featured-extension-card-pomo"]')).toBeNull();
    await press('[data-testid="extension-card-pomo"]');
    expect(page()?.dataset.extensionId).toBe('pomo');
    expect(document.querySelector('[data-testid="extension-card-trace"]')?.getAttribute('aria-current')).toBeNull();
    await press('[data-testid="app-product-back"]');
    expect(page()).toBeNull();
    expect(document.querySelector('[data-testid="featured-extension-card-pomo"]')).not.toBeNull();
  });
});

describe('App variant switching uses the existing install consent', () => {
  let dom: JSDOM;
  let root: Root;
  let queryClient: QueryClient;
  let active: string;
  let asks: boolean;
  const originalList = h.api.list.getMockImplementation();
  const originalUpdates = h.api.marketUpdates.getMockImplementation();
  const originalEntry = h.api.marketEntry.getMockImplementation();
  const variants = ['upstream', 'timeline'].map((name) => ({
    name, base: '1.0.0', dir: name === 'upstream' ? null : '/work/notes@timeline',
    repo: 'https://github.com/example/apps', path: 'notes', commit: 'a'.repeat(40), sha256: 'b'.repeat(64), bytes: 10,
  }));
  const doc = () => dom.window.document;
  const press = async (selector: string) => {
    const element = doc().querySelector<HTMLElement>(selector);
    expect(element, selector).not.toBeNull();
    await act(async () => element!.click());
  };

  beforeEach(() => {
    vi.clearAllMocks();
    active = 'timeline';
    asks = false;
    dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
    dom.window.HTMLElement.prototype.scrollTo = () => {};
    for (const key of ['window', 'document', 'HTMLElement', 'HTMLInputElement', 'Element', 'Node', 'Event', 'navigator', 'MutationObserver'] as const) vi.stubGlobal(key, dom.window[key]);
    vi.stubGlobal('getComputedStyle', dom.window.getComputedStyle.bind(dom.window));
    root = createRoot(doc().querySelector('#root')!);
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    h.api.list.mockImplementation(async () => ({ success: true, data: { extensions: [h.manifest('1.0.0')], invalid: [], icons: {}, disabled: [], origins: { notes: active === 'upstream' ? 'market' : 'fork' }, variants: { notes: { active, variants } } } }));
    h.api.switchVariant.mockImplementation(async (_id: string, name: string, consent: { kind: string }) => {
      const manifest = h.manifest('1.0.0', [], asks ? ['files:read', 'notifications'] : ['files:read']);
      if (consent.kind === 'return') return { success: true, data: { outcome: 'ask', asks, ask: { manifest, manifestDigest: 'variant-digest', installed: h.manifest('1.0.0'), revokedPermissions: [] } } };
      active = name;
      return { success: true, data: { outcome: 'confirmed', manifest } };
    });
  });
  afterEach(() => {
    act(() => root.unmount());
    queryClient.clear();
    dom.window.close();
    vi.unstubAllGlobals();
    h.api.list.mockImplementation(originalList!);
    h.api.marketUpdates.mockImplementation(originalUpdates!);
    h.api.marketEntry.mockImplementation(originalEntry!);
    h.api.switchVariant.mockReset();
  });

  async function openVariantList() {
    await openSettings('notes');
    await render();
    await until('the Notes variants', () => !!doc().querySelector('[data-testid="app-variant-upstream"]'));
    expect(doc().querySelector('[data-testid="app-manage-page"]')).not.toBeNull();
  }

  async function render() {
    await act(async () => root.render(React.createElement(QueryClientProvider, { client: queryClient },
      React.createElement(SessionLocalizationProvider, null, React.createElement(ExtensionsSettingsCard)))));
  }

  it('switches without a dialog when no new permission is needed, then reads the active variant again', async () => {
    await openVariantList();
    await press('[data-testid="app-variant-upstream"]');
    expect(h.showConfirm).not.toHaveBeenCalled();
    expect(h.api.switchVariant.mock.calls).toEqual([
      ['notes', 'upstream', { kind: 'return' }],
      ['notes', 'upstream', { kind: 'given', digest: 'variant-digest' }],
    ]);
    await until('the upstream variant is selected', () => doc().querySelector('[data-testid="app-variant-upstream"]')?.getAttribute('aria-checked') === 'true');
  });

  it.each([false, true])('opens the active fork instead of replacing it with a market update (update listed: %s)', async (listed) => {
    const installFromMarket = vi.fn();
    (h.api as Record<string, unknown>).installFromMarket = installFromMarket;
    h.api.marketEntry.mockResolvedValue({ success: true, data: {
      manifest: h.manifest('2.0.0'), cloud: { compat: null }, ref: { extensionId: 'notes', version: '2.0.0' },
    } } as never);
    h.api.marketUpdates.mockResolvedValue({ success: true, data: {
      checkedAt: '2026-10-26T00:00:00.000Z', yanked: {}, deprecated: {},
      updates: listed ? { notes: { version: '2.0.0' } } : {},
      forkBehind: { notes: { upstream: '2.0.0', behind: 1, commit: 'c'.repeat(40) } },
    } } as never);
    await openVariantList();
    expect(doc().querySelector('[data-testid="app-manage-action"]')?.getAttribute('data-lifecycle')).toBe('open');
    expect(doc().querySelector('.mk-banner .xp-note')?.textContent).toContain('2.0.0');
    await press('[data-testid="app-manage-action"]');
    expect(installFromMarket).not.toHaveBeenCalled();
    expect(h.showConfirm).not.toHaveBeenCalled();
  });

  it('keeps Apps listed when one has no readable variant metadata', async () => {
    h.api.list.mockImplementation(async () => ({ success: true, data: {
      extensions: [h.manifest('1.0.0'), { ...h.manifest('1.0.0'), id: 'other', name: 'Other' }],
      invalid: [], icons: {}, disabled: [], variants: { other: { active, variants } },
    } }));
    await openSettings('notes');
    await render();
    await until('the Notes settings page', () => !!doc().querySelector('[data-testid="app-manage-page"]'));
    expect(h.api.list).toHaveBeenCalledOnce();
    expect(doc().querySelector('[data-testid="app-variants"]')).toBeNull();
    await openSettings('other');
    await until('the Other settings page', () => doc().querySelector('[data-testid="app-manage-page"]')?.getAttribute('data-extension-id') === 'other');
    expect(doc().querySelector('[data-testid="app-variants"]')).not.toBeNull();
  });

  it('waits for the existing consent dialog before installing a variant with additional permissions', async () => {
    asks = true;
    await openVariantList();
    await press('[data-testid="app-variant-upstream"]');
    expect(h.api.switchVariant).toHaveBeenCalledExactlyOnceWith('notes', 'upstream', { kind: 'return' });
    expect(h.showConfirm).toHaveBeenCalledOnce();
    const prompt = h.showConfirm.mock.calls[0]![0] as { onSuccess: () => void };
    await act(async () => prompt.onSuccess());
    expect(h.api.switchVariant).toHaveBeenLastCalledWith('notes', 'upstream', { kind: 'given', digest: 'variant-digest' });
  });
});
