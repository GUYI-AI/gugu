import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  selection: vi.fn(async () => 'standalone' as string),
  installation: vi.fn(async () => ({ version: '158' }) as unknown),
  reserveTab: vi.fn(),
  relax: false,
}));
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, dialog: {} }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }));
vi.mock('@main/lib/events', () => ({ events: { emit: vi.fn() } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: { isRegistered: () => true, unregisterSession: vi.fn() } }));
vi.mock('./remote-task-page', () => ({ watchTaskPageConnection: vi.fn() }));
vi.mock('./task-page-screen', () => ({ connectTaskPageScreen: vi.fn() }));
vi.mock('../settings/settings-service', () => ({ appSettingsService: { get: async () => ({ profiles: [], relaxCorsForLocalhost: m.relax }) } }));
vi.mock('./standalone-kernel-service', () => ({ standaloneKernelService: () => ({
  selection: m.selection, installation: m.installation, pool: { reserveTab: m.reserveTab, closeTab: vi.fn() },
}) }));
import { browserKernelBindings, registerBrowserKernel } from './standalone-page-runtime';
import { bindRemoteBrowser, unbindRemoteBrowser } from './remote-loopback-requests';

const tab = { browserId: 'tab-1', partition: 'persist:gugu-browser-profile-shared', url: 'https://site.test/' };

beforeEach(() => {
  vi.clearAllMocks();
  m.relax = false;
  m.selection.mockResolvedValue('standalone');
  browserKernelBindings.delete(tab.browserId);
  unbindRemoteBrowser(tab.browserId);
});

describe('which engine a tab gets when the standalone browser is selected', () => {
  it('uses the standalone browser for an ordinary tab', async () => {
    expect((await registerBrowserKernel(tab)).kernel).toBe('standalone');
    expect(m.reserveTab).toHaveBeenCalledWith(tab.browserId, tab.partition);
  });

  it('keeps a tab of another machine\'s session on the built-in browser, which forwards its localhost requests to that machine', async () => {
    bindRemoteBrowser(tab.browserId, { deviceId: 'dev-1', sessionId: 'sess-1' });
    expect((await registerBrowserKernel(tab)).kernel).toBe('builtin');
    expect((await registerBrowserKernel({ ...tab, browserId: 'tab-2', kernel: 'standalone' })).kernel).toBe('standalone'); // Only that tab is held back.
    expect(m.reserveTab).not.toHaveBeenCalledWith(tab.browserId, expect.anything());
  });

  it('keeps every tab on the built-in browser while "relax CORS for localhost" is on, which only the built-in browser can do', async () => {
    m.relax = true;
    expect((await registerBrowserKernel(tab)).kernel).toBe('builtin');
    expect((await registerBrowserKernel({ ...tab, browserId: 'tab-3', kernel: 'standalone' })).kernel).toBe('builtin');
    expect(m.reserveTab).not.toHaveBeenCalled();
  });

  it('keeps the tab of a window the standalone Chrome already made on the standalone browser, which no built-in tab can show: "relax CORS" does not move it', async () => {
    m.relax = true;
    expect((await registerBrowserKernel({ ...tab, browserId: 'tab-4', kernel: 'standalone', adoptsWindow: true })).kernel).toBe('standalone');
    expect((await registerBrowserKernel({ ...tab, browserId: 'tab-5', kernel: 'standalone' })).kernel).toBe('builtin'); // Any other tab still follows the rule.
    expect(m.reserveTab).toHaveBeenCalledExactlyOnceWith('tab-4', tab.partition);
    browserKernelBindings.delete('tab-4');
    browserKernelBindings.delete('tab-5');
  });

  it('still keeps a window\'s tab off the standalone browser when the person chose the built-in one or the tab is of another machine\'s session', async () => {
    m.selection.mockResolvedValue('builtin');
    expect((await registerBrowserKernel({ ...tab, kernel: 'builtin', adoptsWindow: true })).kernel).toBe('builtin');
    m.selection.mockResolvedValue('standalone');
    bindRemoteBrowser('tab-6', { deviceId: 'dev-1', sessionId: 'sess-1' });
    expect((await registerBrowserKernel({ ...tab, browserId: 'tab-6', kernel: 'standalone', adoptsWindow: true })).kernel).toBe('builtin');
    unbindRemoteBrowser('tab-6');
    browserKernelBindings.delete('tab-6');
  });

  it('does not look at either when the built-in browser was chosen anyway', async () => {
    m.selection.mockResolvedValue('builtin');
    expect((await registerBrowserKernel(tab)).kernel).toBe('builtin');
    expect(m.installation).not.toHaveBeenCalled();
    expect(m.reserveTab).not.toHaveBeenCalled();
  });

  it('does not start a standalone profile for an explicit built-in tab when standalone is the default', async () => {
    expect((await registerBrowserKernel({ ...tab, kernel: 'builtin' })).kernel).toBe('builtin');
    expect(m.installation).not.toHaveBeenCalled();
    expect(m.reserveTab).not.toHaveBeenCalled();
  });
});
