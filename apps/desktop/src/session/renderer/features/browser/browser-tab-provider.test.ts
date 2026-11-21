import { beforeEach, describe, expect, it, vi } from 'vitest';

const m = vi.hoisted(() => ({
  settings: undefined as undefined | { kernel?: 'builtin' | 'standalone'; defaultProfileId?: string; profiles?: { id: string; name: string }[] },
}));
vi.mock('@renderer/features/sessions/workspace-backend/workspace-backend', () => ({ workspaceBackend: () => ({ browser: { persistent: true } }) }));
vi.mock('@renderer/features/settings/app-settings-client', () => ({ getAppSettingValueSnapshot: () => m.settings }));
vi.mock('@renderer/features/tabs/core/tab-provider-registry', () => ({ createTabProvider: (provider: unknown) => provider }));
vi.mock('@renderer/features/tabs/core/tab-views', () => ({ registeredTabView: () => () => null }));
vi.mock('./browser-tab-item', () => ({ BrowserTabBarItem: () => null, BrowserTabBarItemDragPreview: () => null }));
vi.mock('./browser-tab-resource', () => ({ BrowserTabResource: class {} }));
import { BROWSER_ISOLATED_PROFILE_ID, browserPartitionForProfile } from '@shared/browser';
import { browserSessionStore } from './browser-session-store';
import { popupClaims } from './browser-popup-claims';
import { browserTabProvider } from './browser-tab-provider';

const ctx = { projectId: 'p', workspaceId: 'w', sessionId: 's' } as never;
const open = (args: Parameters<NonNullable<typeof browserTabProvider.onBeforeOpen>>[0]) => {
  const state = browserTabProvider.onBeforeOpen!(args, ctx)!;
  return browserSessionStore.getSession(state.browserId)!;
};

beforeEach(() => {
  browserSessionStore.clear();
  m.settings = { kernel: 'builtin', defaultProfileId: 'work', profiles: [{ id: 'work', name: 'Work' }, { id: 'default', name: 'Default' }] };
});

describe('the profile and engine of a tab that is opened', () => {
  it('is the profile and engine chosen in Settings for any tab: the built-in browser\'s tabs, links, and a window\'s tab without a profile to follow', () => {
    const tab = open({ initialUrl: 'https://site.test/' });
    expect(tab).toMatchObject({ kernel: 'builtin', profileId: 'work', partition: browserPartitionForProfile(tab, 'work') });
    m.settings = { ...m.settings, kernel: 'standalone', defaultProfileId: BROWSER_ISOLATED_PROFILE_ID };
    const isolated = open({ initialUrl: 'https://site.test/' });
    expect(isolated).toMatchObject({ kernel: 'standalone', profileId: BROWSER_ISOLATED_PROFILE_ID, partition: browserPartitionForProfile(isolated, BROWSER_ISOLATED_PROFILE_ID) });
    const noOwner = open({ initialUrl: 'https://github.com/login', popup: 'P0' });
    expect(noOwner).toMatchObject({ profileId: BROWSER_ISOLATED_PROFILE_ID, kernel: 'standalone' });
    expect(popupClaims.take(noOwner.browserId)).toBe('P0');
  });

  it('is the page\'s own profile, partition and the standalone engine for the tab of a window its Chrome made, whatever Settings say', () => {
    const owner = { profileId: BROWSER_ISOLATED_PROFILE_ID, partition: browserPartitionForProfile({ browserId: 'src', projectId: 'p', workspaceId: 'w', sessionId: 's' }, BROWSER_ISOLATED_PROFILE_ID) };
    for (const settings of [m.settings, { kernel: 'builtin' as const, defaultProfileId: 'default' }, undefined]) {
      m.settings = settings;
      const tab = open({ initialUrl: 'https://github.com/login', popup: 'P1', windowOf: owner });
      expect(tab).toMatchObject({ kernel: 'standalone', profileId: owner.profileId, partition: owner.partition });
      expect(popupClaims.take(tab.browserId)).toBe('P1');
    }
  });

  it('never lets a profile to follow reach a tab that was not opened for a window', () => {
    const owner = { profileId: 'work', partition: 'persist:gugu-browser-profile-work' };
    m.settings = { kernel: 'builtin', defaultProfileId: 'default' };
    const tab = open({ initialUrl: 'https://site.test/', windowOf: owner });
    expect(tab).toMatchObject({ kernel: 'builtin', profileId: 'default', partition: browserPartitionForProfile(tab, 'default') });
    expect(popupClaims.has(tab.browserId)).toBe(false);
  });
});
