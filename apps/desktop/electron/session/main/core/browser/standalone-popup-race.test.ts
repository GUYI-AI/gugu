import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  emit: vi.fn(),
  pageFor: vi.fn(),
}));
vi.mock('electron', () => ({ clipboard: {}, ClipboardItem: class {}, dialog: {} }));
vi.mock('@main/app/window', () => ({ getMainWindow: () => null }));
vi.mock('@main/lib/events', () => ({ events: { emit: m.emit } }));
vi.mock('@main/lib/logger', () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('./browser-webcontents-registry', () => ({ browserWebContentsRegistry: { isRegistered: () => true, unregisterSession: vi.fn() } }));
vi.mock('./remote-task-page', () => ({ watchTaskPageConnection: vi.fn() }));
vi.mock('./task-page-screen', () => ({ connectTaskPageScreen: vi.fn() }));
vi.mock('../settings/settings-service', () => ({ appSettingsService: { get: async () => ({ profiles: [], relaxCorsForLocalhost: false }) } }));
vi.mock('./standalone-kernel-service', () => ({ standaloneKernelService: () => ({ pool: { pageFor: m.pageFor, reserveTab: vi.fn(), closeTab: vi.fn() } }) }));
import { browserCloseTabChannel } from '@shared/events/browserEvents';
import { TaskPopupClosed } from '../../../../server/task-popups';
import { browserKernelBindings, standalonePage } from './standalone-page-runtime';

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

  it('leaves the tab alone when the page could not be opened for any other reason', async () => {
    m.pageFor.mockRejectedValueOnce(new Error('Chrome is not installed'));
    await expect(standalonePage('popup-tab', 'https://site.test/')).rejects.toThrow('Chrome is not installed');
    expect(m.emit).not.toHaveBeenCalled();
  });
});
