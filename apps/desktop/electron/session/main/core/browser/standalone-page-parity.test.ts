import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  host: vi.fn(async () => ({})), zoom: vi.fn(async () => {}), control: vi.fn(async () => {}),
  setCookie: vi.fn(), flush: vi.fn(), clearProfile: vi.fn(), clearAll: vi.fn(), clearPage: vi.fn(),
  cookieImport: vi.fn(async (_id: string, _sink?: unknown) => ({ ok: true })),
  selection: vi.fn(async () => 'standalone'), registryClear: vi.fn(async () => true),
}));
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {} }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('./browser-cookie-import', () => ({ defaultBrowser: () => ({ name: 'Fixture' }), importDefaultBrowserCookies: m.cookieImport }));
vi.mock('./browser-annotation', () => ({ inspectBrowserAnnotation: vi.fn() }));
vi.mock('./browser-profile-session', () => ({ configureBrowserProfileSession: vi.fn() }));
vi.mock('./browser-partition-cleanup', () => ({ listPersistedBrowserPartitions: async () => [] }));
vi.mock('./browser-page-views', () => ({ destroyBrowserPage: vi.fn(), ensureAgentBrowserPage: vi.fn(), focusBrowserHost: vi.fn(),
  layoutBrowserPage: vi.fn(), measureBrowserPage: vi.fn(), mountBrowserPage: vi.fn(), navigateBrowserPage: vi.fn(),
  releaseBrowserPage: vi.fn(), runBrowserPageCommand: vi.fn(), setBrowserPageZoom: vi.fn(), snapshotBrowserPage: vi.fn() }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: {
  isRegistered: () => true, clearProfileStorage: m.registryClear, clearBrowsingData: m.registryClear,
  registeredPartitions: [],
} }));
vi.mock('./remote-task-page', () => ({ controlRemoteTaskPage: vi.fn(), sendRemoteTaskPage: vi.fn(), unwatchRemoteTaskPage: vi.fn(),
  watchRemoteTaskPage: vi.fn(), watchTaskPageConnection: vi.fn() }));
vi.mock('./task-page-screen', () => ({ connectTaskPageScreen: vi.fn() }));
vi.mock('../settings/settings-service', () => ({ appSettingsService: { get: async () => ({ profiles: [] }) } }));
vi.mock('./standalone-kernel-service', () => ({ standaloneKernelService: () => ({
  selection: m.selection,
  profileData: { cookies: () => ({ set: m.setCookie, flushStore: m.flush }), clear: m.clearProfile, clearAll: m.clearAll },
  pool: {
    pageFor: async () => ({ hostCommand: m.host, setZoomFactor: m.zoom }),
    existingPage: async () => ({ state: () => ({ url: 'https://fixture.test', isLoading: false }), on: vi.fn(), once: vi.fn(), control: m.control }),
  },
}) }));
import { browserController } from './controller';
import { browserKernelBindings, standaloneCommand, watchStandalonePage } from './standalone-page-runtime';
import { watchTaskPageConnection } from './remote-task-page';
import { connectTaskPageScreen } from './task-page-screen';

beforeEach(() => {
  vi.clearAllMocks();
  browserKernelBindings.delete('parity');
  browserKernelBindings.bind({ browserId: 'parity', partition: 'persist:gugu-browser-profile-shared' }, 'standalone');
});
describe('existing browser interactions after changing engine', () => {
  it('uses layout zoom, never pinch scale, when restoring the saved zoom', async () => {
    await browserController.setPageZoom({ browserId: 'parity', factor: 0.5 });
    expect(m.zoom).toHaveBeenCalledWith(0.5);
    expect(m.host).not.toHaveBeenCalledWith('Emulation.setPageScaleFactor', expect.anything());
  });
  it('finishes the first pane resize before it connects a picture viewer', async () => {
    let finishResize!: () => void;
    let resizeStarted!: () => void;
    const started = new Promise<void>(resolve => { resizeStarted = resolve; });
    m.control.mockImplementationOnce(() => {
      resizeStarted();
      return new Promise<void>(resolve => { finishResize = resolve; });
    });
    vi.mocked(watchTaskPageConnection).mockImplementationOnce(async (_id, connect) => {
      await connect();
      return { success: true };
    });
    const watching = watchStandalonePage({ browserId: 'parity', watchId: 'first-picture',
      viewport: { width: 361, height: 795, scale: 1 } });
    await Promise.race([started, watching]);
    try {
      expect(m.control).toHaveBeenCalledWith({ action: 'resize', width: 361, height: 795, scale: 1 });
      expect(connectTaskPageScreen).not.toHaveBeenCalled();
    } finally {
      finishResize?.();
      await watching;
    }
    expect(connectTaskPageScreen).toHaveBeenCalledOnce();
  });

  it('retains ignoreCache on force reload; normal reload stays normal', async () => {
    await standaloneCommand('parity', 'reloadIgnoringCache');
    expect(m.host).toHaveBeenCalledWith('Page.reload', { ignoreCache: true });
    await standaloneCommand('parity', 'reload');
    expect(m.control).toHaveBeenCalledWith({ action: 'reload' });
  });
  it('imports default-browser cookies through the selected engine sink', async () => {
    expect(await browserController.importDefaultBrowserCookies('work')).toEqual({ ok: true });
    expect(m.cookieImport).toHaveBeenCalledWith('work', { set: m.setCookie, flushStore: m.flush });
  });
  it('clears the selected profile in both engines, including a dormant standalone profile', async () => {
    expect(await browserController.clearProfileStorage('work')).toEqual({ success: true });
    expect(m.clearProfile).toHaveBeenCalledWith('persist:gugu-browser-profile-work', 'all');
    expect(m.registryClear).toHaveBeenCalledWith('work');
  });
  it('routes every global data category to both engines without pretending dormant data is absent', async () => {
    for (const kind of ['cookies', 'cache', 'siteData', 'all']) {
      expect(await browserController.clearBrowsingData(kind)).toEqual({ success: true });
      expect(m.clearAll).toHaveBeenCalledWith(kind);
    }
  });
});
