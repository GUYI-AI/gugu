import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  emit: vi.fn(),
  pageFor: vi.fn(),
  existingPage: vi.fn(),
}));
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, dialog: {} }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }));
vi.mock('@main/lib/events', () => ({ events: { emit: m.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: { isRegistered: () => true, unregisterSession: vi.fn() } }));
vi.mock('./remote-task-page', () => ({ watchTaskPageConnection: vi.fn() }));
vi.mock('./task-page-screen', () => ({ connectTaskPageScreen: vi.fn() }));
vi.mock('../settings/settings-service', () => ({ appSettingsService: { get: async () => ({ profiles: [], relaxCorsForLocalhost: false }) } }));
vi.mock('./standalone-kernel-service', () => ({ standaloneKernelService: () => ({ pool: { pageFor: m.pageFor, existingPage: m.existingPage, reserveTab: vi.fn(), closeTab: vi.fn() } }) }));
import { browserCloseTabChannel, browserPageEventChannel } from '@shared/events/browserEvents';
import { TaskPageClosedDuringOpen, TaskPopupClosed } from '../../../../server/task-popups';
import { browserKernelBindings, mountStandalonePage, standalonePage } from './standalone-page-runtime';

beforeEach(() => {
  vi.clearAllMocks();
  browserKernelBindings.delete('popup-tab');
  browserKernelBindings.bind({ browserId: 'popup-tab', partition: 'persist:gugu-browser-profile-shared' }, 'standalone');
});

describe('a tab opened for a window the page had already closed', () => {
  it('closes itself: the window did its work and went, and the address must not load again', async () => {
    m.pageFor.mockRejectedValueOnce(new TaskPopupClosed('https://auth.test/login'));
    await expect(standalonePage('popup-tab', 'https://auth.test/login')).rejects.toBeInstanceOf(TaskPopupClosed);
    expect(m.emit).toHaveBeenCalledExactlyOnceWith(browserCloseTabChannel, { browserId: 'popup-tab' });
  });

  it('asks the browser for the window it was opened for by that window\'s id, and for none when it was not opened for one', async () => {
    m.pageFor.mockRejectedValueOnce(new Error('stop here')).mockRejectedValueOnce(new Error('stop here'));
    await expect(standalonePage('popup-tab', 'about:blank', undefined, 'P1')).rejects.toThrow('stop here');
    await expect(standalonePage('popup-tab', 'about:blank')).rejects.toThrow('stop here');
    expect(m.pageFor.mock.calls.map(([input]) => input.popup)).toEqual(['P1', undefined]);
  });

  it('leaves the tab alone when the page could not be opened for any other reason', async () => {
    m.pageFor.mockRejectedValueOnce(new Error('Chrome is not installed'));
    await expect(standalonePage('popup-tab', 'https://site.test/')).rejects.toThrow('Chrome is not installed');
    expect(m.emit).not.toHaveBeenCalled();
  });

  it('keeps an empty tab at the requested address if its newly created page closes while opening', async () => {
    const url = 'http://127.0.0.1/instant-close';
    const state = { url: 'about:blank', title: '', isLoading: false };
    const page = Object.assign(new EventEmitter(), { state: () => state, getURL: () => state.url });
    m.pageFor.mockRejectedValueOnce(new TaskPageClosedDuringOpen()).mockResolvedValue(page);
    m.existingPage.mockResolvedValue(page);

    await expect(mountStandalonePage({ browserId: 'popup-tab', partition: 'persist:gugu-browser-profile-shared', url })).resolves.toMatchObject({
      success: true, state: { url },
    });
    expect(m.pageFor.mock.calls.map(([input]) => input.url).filter(Boolean)).toEqual([url, 'about:blank']);
    expect(page.getURL()).toBe('about:blank');
    expect(m.emit).not.toHaveBeenCalledWith(browserCloseTabChannel, expect.anything());
    expect(m.emit).toHaveBeenCalledWith(browserPageEventChannel, expect.objectContaining({ type: 'did-navigate', state: { ...state, url } }));

    state.url = 'http://127.0.0.1/next';
    page.emit('state');
    expect(m.emit).toHaveBeenCalledWith(browserPageEventChannel, expect.objectContaining({ type: 'did-navigate', state: { ...state } }));
    state.url = 'about:blank';
    page.emit('state');
    expect(m.emit).toHaveBeenCalledWith(browserPageEventChannel, expect.objectContaining({ type: 'did-navigate', state: { ...state } }));
    page.emit('destroyed');
  });

  it('does not retry the URL or hide an error creating the replacement blank page', async () => {
    m.pageFor.mockRejectedValueOnce(new TaskPageClosedDuringOpen()).mockRejectedValueOnce(new Error('browser exited'));
    const url = 'http://127.0.0.1/instant-close';
    await expect(standalonePage('popup-tab', url)).rejects.toThrow('browser exited');
    expect(m.pageFor.mock.calls.map(([input]) => input.url)).toEqual([url, 'about:blank']);
    expect(m.emit).not.toHaveBeenCalled();
  });
});
