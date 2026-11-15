// @vitest-environment jsdom
import { EXTENSION_API_VERSION } from '@shared/extensions/manifest';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const api = vi.hoisted(() => ({
  list: vi.fn(),
  marketUpdates: vi.fn(),
  setDisclosure: vi.fn(),
}));
vi.mock('@renderer/lib/ipc', () => ({ rpc: { extensions: api }, rpcOn: () => ({ extensions: api }) }));
vi.mock('@renderer/utils/logger', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

const {
  appsOf, installedExtensions, marketUpdates, peekInstalledApps, setDisclosure, tellInstalled, updateCountOf, writeInstalled,
  DOCK_KEPT_NAME_MAX, DOCK_KEPT_SLOTS,
} = await import('./installed-extensions');
type InstalledExtensionsList = import('./installed-extensions').InstalledExtensionsList;
type InstalledApps = import('./installed-extensions').InstalledApps;
const { queryClient } = await import('@/lib/replica');

const manifestOf = (id: string, name = id) => ({
  id, name, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', entry: 'index.html',
  contributes: { tabs: [{ name: 'main', title: name }] },
});
const listOf = (extensions: unknown[], more: Record<string, unknown> = {}) =>
  ({ extensions, invalid: [], icons: {}, disabled: [], disclosure: {}, ...more }) as unknown as InstalledExtensionsList;

beforeEach(() => {
  queryClient.removeQueries({ queryKey: [installedExtensions.name] });
  queryClient.removeQueries({ queryKey: [marketUpdates.name] });
  vi.clearAllMocks();
});

describe('披露档位的写入 (W-08)', () => {
  it('先按用户拨的画,落定后以主进程的回答为准', async () => {
    let settle!: (value: unknown) => void;
    api.setDisclosure.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    tellInstalled('local', listOf([], { disclosure: { tools: 'progressive' } }));
    const writing = setDisclosure('local', 'tools', 'full');
    expect(peekInstalledApps('local')?.disclosure.tools).toBe('full');
    settle({ success: true, data: { level: 'full' } });
    await writing;
    expect(peekInstalledApps('local')?.disclosure.tools).toBe('full');
  });

  // I4: a refused write is not put back to what was there when it began; the list is read again (the truth may have moved).
  it('写不进去就重读清单(以主进程为准),并把失败交给调用方', async () => {
    api.setDisclosure.mockResolvedValue({ success: false, error: 'not installed' });
    api.list.mockResolvedValue({ success: true, data: listOf([], { disclosure: { tools: 'progressive' } }) });
    tellInstalled('local', listOf([], { disclosure: { tools: 'progressive' } }));
    await expect(setDisclosure('local', 'tools', 'full')).rejects.toThrow('not installed');
    await installedExtensions.fetch('local');
    await vi.waitFor(() => expect(api.list).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(peekInstalledApps('local')?.disclosure.tools).toBe('progressive'));
  });

  it('不给 agent 工具的扩展没有档位可写', async () => {
    tellInstalled('local', listOf([], { disclosure: { tools: 'progressive' } }));
    await expect(setDisclosure('local', 'plain', 'full')).rejects.toThrow('gives agents no tools');
  });
});

describe('the dock kept across restarts (PLAN v2 C4)', () => {
  // What the snapshot keeps of a value put under a host's key (the definition's carry, as writing applies it).
  const carry = (value: unknown, hostKey = 'local') => {
    localStorage.clear();
    queryClient.removeQueries({ queryKey: [installedExtensions.name] });
    installedExtensions.set([hostKey], value as never);
    const block = JSON.parse(localStorage.getItem('gugu.readModel.v1:device') ?? '{}') as Record<string, { key: unknown[]; value: unknown }>;
    return Object.values(block).find((kept) => kept.key[0] === installedExtensions.name && kept.key[2] === hostKey)?.value;
  };

  it('keeps only the docked Apps\' ids and names; a name too long leaves its App out (never cut short)', () => {
    const long = 'x'.repeat(DOCK_KEPT_NAME_MAX + 1);
    const list = listOf([manifestOf('clock'), manifestOf('wide', long), manifestOf('plain')], { dock: ['clock', 'wide', 'plain'], appIcons: { clock: 'data:image/png;base64,AAAA' } });
    expect(carry({ list })).toEqual({ dock: { slots: [{ extensionId: 'clock', name: 'clock' }, null, { extensionId: 'plain', name: 'plain' }], count: 3 } });
  });

  it('is bounded by construction: 100 docked Apps with the longest names keep 12 slots within the declared 2,048 B', () => {
    const ids = Array.from({ length: 100 }, (_, i) => `a${String(i).padStart(2, '0')}-${'z'.repeat(59)}`);
    const list = listOf(ids.map((id) => manifestOf(id, '名'.repeat(DOCK_KEPT_NAME_MAX))), { dock: ids });
    const kept = carry({ list }) as { dock: { slots: unknown[]; count: number } };
    expect(kept.dock.slots).toHaveLength(DOCK_KEPT_SLOTS);
    expect(kept.dock.count).toBe(100);
    const block = localStorage.getItem('gugu.readModel.v1:device') ?? '';
    const entry = Object.values(JSON.parse(block) as Record<string, unknown>)[0];
    expect(JSON.stringify(entry).length).toBeLessThanOrEqual(2048);
  });

  it('another desktop\'s list and the phone\'s are not kept; a restored value carries as it is', () => {
    const list = listOf([manifestOf('clock')], { dock: ['clock'] });
    expect(carry({ list }, 'remote:mac2')).toBeUndefined();
    expect(carry({ list }, 'phone')).toBeUndefined();
    const restored = { dock: { slots: [{ extensionId: 'clock', name: 'clock' }], count: 1 } };
    expect(carry(restored)).toEqual(restored);
  });

  it('a restored value (the dock only) is not a list: readers see what is installed as not known yet', () => {
    installedExtensions.set(['local'], { dock: { slots: [], count: 0 } });
    expect(peekInstalledApps('local')).toBeNull();
  });
});

describe('writeInstalled', () => {
  it('puts the host\'s answer over what was drawn at once', async () => {
    tellInstalled('local', listOf([], { dock: ['a'] }));
    await writeInstalled('local', (list) => ({ ...list, dock: ['b'] }), async () => ['c'], (dock) => (list) => ({ ...list, dock }));
    expect(peekInstalledApps('local')?.dock).toEqual(['c']);
  });
});

describe('marketUpdates', () => {
  it('reads the summary and the versions offered; the snapshot keeps only the versions and the gone ones', async () => {
    localStorage.clear();
    api.marketUpdates.mockResolvedValue({ success: true, data: {
      checkedAt: 'x', updates: { clock: { version: '2.0.0', releaseNotes: 'long notes' } }, yanked: {}, deprecated: {}, gone: ['old'],
    } });
    const value = await marketUpdates.fetch('local');
    expect(value).toMatchObject({ offered: { clock: '2.0.0' }, gone: ['old'] });
    expect(value.summary?.updates.clock?.releaseNotes).toBe('long notes');
    const block = JSON.parse(localStorage.getItem('gugu.readModel.v1:device') ?? '{}') as Record<string, { key: unknown[]; value: unknown }>;
    const kept = Object.values(block).find((entry) => entry.key[0] === marketUpdates.name);
    expect(kept?.value).toEqual({ offered: { clock: '2.0.0' }, gone: ['old'] });
  });

  it('a read that fails is an error, ❌ "no updates"', async () => {
    api.marketUpdates.mockResolvedValue({ success: false, error: 'offline' });
    await expect(marketUpdates.fetch('local')).rejects.toThrow('offline');
  });
});

describe('which Apps are a task session tab (L6-8, 摩擦单 F3 / F95 / F98)', () => {
  const app = (id: string, opensFiles?: unknown) => ({
    id,
    name: id,
    version: '1.0.0',
    apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
    entry: 'index.html',
    contributes: { tabs: [{ name: 'main', title: id, ...(opensFiles === undefined ? {} : { opensFiles }) }] },
  });
  const listing = (extensions: unknown[], more: Record<string, unknown> = {}) =>
    ({ extensions, invalid: [], icons: {}, disabled: [], disclosure: {}, ...more }) as unknown as InstalledExtensionsList;
  const storeListing = (extensions: unknown[], more: Record<string, unknown> = {}, locale = 'zh-CN') => appsOf(listing(extensions, more), locale);
  const withList = (apps: InstalledApps, more: Record<string, unknown>) => appsOf({ ...apps.list, ...more } as InstalledExtensionsList, apps.locale);

  it('names the default page in the interface language and preserves a specifically named subpage', async () => {
    const calendar = { ...app('calendar'), name: '日历', defaultLocale: 'zh-CN', localized: { en: { name: 'Calendar' } }, contributes: { tabs: [
      { name: 'main', title: '日历' }, { name: 'reports', title: 'Reports' },
    ] } };
    const store = storeListing([calendar], {}, 'en-US');
    expect(store.tabTitle('calendar.main')).toBe('Calendar');
    expect(store.tabTitle('calendar.reports')).toBe('Reports');
    expect(store.tabTitle('missing.main')).toBeUndefined();
  });

  // F95 (S23): a「TODO 看板」tab bound to no file — "Open a .todo-kanban.json file" and an uncaught error. A tab that
  // opens files, in a session or a group, is opened for a file; with none it has nothing to show.
  it('a tab that opens files is no session tab of its own — it still has its page where a file opens it', async () => {
    const store = storeListing([app('vote', { chat: ['.vote.json'] }), app('grid', { session: ['.csv'] }), app('plain'), app('board', { session: ['TODO.md'] })]);
    expect(store.enabledTabContributions.map((entry) => entry.extensionId)).toEqual(['plain']);
    expect(store.residentTabContributions.map((entry) => entry.extensionId)).toEqual(['vote', 'grid', 'plain', 'board']);
  });

  it('a tab with a card is not a page beside other tabs, but stays one when it is all the App has', async () => {
    const withTabs = (id: string, tabs: object[]) => ({ id, name: id, version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', contributes: { tabs } });
    const widget = { height: 120 };
    let store = storeListing([
      withTabs('board', [{ name: 'board', title: 'Board', entry: 'b.html' }, { name: 'fleet', title: 'Fleet', entry: 'f.html', widget }]),
      withTabs('lens', [{ name: 'card', title: 'Lens', entry: 'c.html', widget }, { name: 'explore', title: 'Lens', entry: 'e.html', opensFiles: { chat: ['.csv'] } }]),
      withTabs('poll', [{ name: 'poll', title: 'Poll', entry: 'p.html', widget }]),
    ]);
    expect(store.enabledTabContributions.map((entry) => entry.kind)).toEqual(['board.board', 'poll.poll']);
    // Only those lists: a published App keeps its place on the rail and what an open with no tab reaches.
    expect(store.mainTabOf('lens')?.kind).toBe('lens.card');
    expect(store.residentTabContributions.map((entry) => entry.kind)).toContain('board.fleet');
    // Its one page taken out of the menus: the App leaves the rail, not its card taking the page's place.
    store = withList(store, { hiddenTabs: { board: ['board'] } });
    expect(store.mainTabOf('board')).toBeNull();
  });

  it('a page taken out of the menus: the next one is the App\'s main page; with none left the App leaves the rail', async () => {
    const two = { id: 'two', name: 'Two', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en', contributes: { tabs: [{ name: 'a', title: 'A', entry: 'a.html' }, { name: 'b', title: 'B', entry: 'b.html' }] } };
    let store = storeListing([two], { dock: ['two'], hiddenTabs: { two: ['a'] } });
    expect(store.mainTabOf('two')?.kind).toBe('two.b');
    expect(store.dockedApps.map((app) => app.kind)).toEqual(['two.b']);
    expect(store.enabledTabContributions.map((entry) => entry.kind)).toEqual(['two.b']);
    store = withList(store, { hiddenTabs: { two: ['a', 'b'] } });
    expect(store.mainTabOf('two')).toBeNull();
    expect(store.dockedApps).toEqual([]);
  });

  it('keeps an App-owned per-task HTML page separate from its settings page', async () => {
    const appWithPages = {
      id: 'tool', name: 'Tool', version: '1.0.0', apiVersion: EXTENSION_API_VERSION, defaultLocale: 'en',
      contributes: { tabs: [
        { name: 'settings', title: 'Settings', hostPage: 'settings' },
        { name: 'view', title: 'View', entry: 'view.html', perSession: true },
      ] },
    };
    const store = storeListing([appWithPages]);
    expect(store.allTabContributions.find(entry => entry.kind === 'tool.view')).toMatchObject({ hostSettings: false, perSession: true });
    expect(store.allTabContributions.find(entry => entry.kind === 'tool.settings')).toMatchObject({ hostSettings: true });
    expect(store.mainTabOf('tool')?.kind).toBe('tool.settings');
  });

  // owner 10-20「没有 enable 的 app,在任务页的新建 tab 里面就不要显示了吧,灰掉也占位置」: the「+」menu, an empty pane
  // and the draft panel all list this, so a switched-off App is left out of it — and back the moment it is on.
  it('a switched-off App is no session tab until it is switched back on', async () => {
    let store = storeListing([app('plain'), app('off')], { disabled: ['off'] });
    expect(store.enabledTabContributions.map((entry) => entry.extensionId)).toEqual(['plain']);
    store = withList(store, { disabled: [] });
    expect(store.enabledTabContributions.map((entry) => entry.extensionId)).toEqual(['plain', 'off']);
  });

  // The far-left rail's dock (统筹 10-01): what is pinned, in the person's order — when it is here, on, and has a page.
  it('the rail shows the pinned Apps that can open from it, in the dock’s order, with their own icon', async () => {
    let store = storeListing([app('plain'), app('clock'), app('vote', { chat: ['.vote.json'] }), app('off')], {
      dock: ['clock', 'gone', 'vote', 'off', 'plain'],
      disabled: ['off'],
      appIcons: { clock: 'data:image/png;base64,AAAA' },
    });
    expect(store.dockedApps).toEqual([
      { extensionId: 'clock', name: 'clock', kind: 'clock.main', iconDataUrl: 'data:image/png;base64,AAAA' },
      { extensionId: 'plain', name: 'plain', kind: 'plain.main', iconDataUrl: null },
    ]);
    // Switched back on, it is back in its place: the dock keeps it while it is off.
    store = withList(store, { disabled: [] });
    expect(store.dockedApps.map((entry) => entry.extensionId)).toEqual(['clock', 'off', 'plain']);
  });
});

// owner 10-20「我没懂为什么我的 app 页有红点」: three switched-off Apps with a newer version lit it, though they sit in
// 「已停用」 and nothing said which. VS Code's badge counts only enabled outdated extensions (extensionsViewlet.ts L1052).
describe('the 「App」 badge (updateCountOf)', () => {
  const summary = {
    checkedAt: '2026-10-20T00:00:00.000Z',
    updates: { off: { version: '2.0.0', releaseNotes: '' }, on: { version: '2.0.0', releaseNotes: '' } },
    yanked: { 'off-yanked': { reason: 'broken', installable: null } },
    deprecated: {},
    gone: [],
  };
  const appsDisabled = (disabled: string[]) => appsOf({ extensions: [], invalid: [], icons: {}, disabled, disclosure: {} } as unknown as InstalledExtensionsList, 'en');

  it('counts a newer version only of an App that is on; a yanked one is counted on or off', () => {
    expect(updateCountOf(summary, appsDisabled(['off', 'off-yanked']))).toBe(2);
    expect(updateCountOf(summary, appsDisabled(['on', 'off', 'off-yanked']))).toBe(1);
    expect(updateCountOf(summary, appsDisabled([]))).toBe(3);
  });
});
