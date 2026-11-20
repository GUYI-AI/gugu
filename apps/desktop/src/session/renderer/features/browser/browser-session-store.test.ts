import { describe, expect, it } from 'vitest';
import { BROWSER_ISOLATED_PROFILE_ID, browserPartitionForProfile } from '@shared/browser';
import { BrowserSessionStore } from './browser-session-store';

function setup() {
  const store = new BrowserSessionStore();
  const session = store.createSession({
    projectId: 'remote:dev-1',
    workspaceId: 'conv-1',
    sessionId: 'conv-1',
    initialUrl: 'file:///root/proj/index.html',
  });
  return { store, browserId: session.browserId };
}

describe('browser engine snapshots', () => {
  it('remembers the engine at creation even before the page surface mounts', () => {
    const store = new BrowserSessionStore();
    const page = store.createSession({ projectId: 'p', workspaceId: 'w', sessionId: 'task', kernel: 'standalone' });
    expect(store.getSnapshot(page.browserId)?.kernel).toBe('standalone');
    store.updateSession(page.browserId, { currentUrl: 'https://example.test' });
    expect(store.getSnapshot(page.browserId)?.kernel).toBe('standalone');
    expect(new BrowserSessionStore().restoreSession(store.getSnapshot(page.browserId)!).kernel).toBe('standalone');
  });

  it('keeps a legacy restored tab on the built-in browser', () => {
    const { store, browserId } = setup();
    const legacy = store.getSnapshot(browserId)!;
    expect(legacy.kernel).toBeUndefined();
    expect(new BrowserSessionStore().restoreSession(legacy).kernel).toBe('builtin');
  });
});

describe('the partition of a tab', () => {
  const identity = { projectId: 'p', workspaceId: 'w', sessionId: 'task' };

  it('works out from its identity and profile unless it is told one, as before: named, default and isolated profiles', () => {
    const store = new BrowserSessionStore();
    for (const profileId of ['default', 'work', BROWSER_ISOLATED_PROFILE_ID]) {
      const tab = store.createSession({ ...identity, profileId });
      expect(tab.partition).toBe(browserPartitionForProfile(tab, profileId));
    }
    expect(store.createSession({ ...identity }).partition).toBe(browserPartitionForProfile({ ...identity, browserId: 'x' }, 'default'));
  });

  it('is the partition a sign-in window\'s tab is told to live in, and is written to and read back from the snapshot', () => {
    const store = new BrowserSessionStore();
    const page = store.createSession({ ...identity, kernel: 'standalone', profileId: BROWSER_ISOLATED_PROFILE_ID });
    const popup = store.createSession({ ...identity, kernel: 'standalone', profileId: page.profileId, partition: page.partition, initialUrl: 'https://github.com/login' });
    expect(popup.partition).toBe(page.partition);
    expect(popup.browserId).not.toBe(page.browserId);
    // What is saved is what has always been saved: restoring it (an app restart) gives the tab the same profile and partition.
    const restored = new BrowserSessionStore().restoreSession(JSON.parse(JSON.stringify(store.getSnapshot(popup.browserId))));
    expect(restored).toMatchObject({ kernel: 'standalone', profileId: BROWSER_ISOLATED_PROFILE_ID, partition: page.partition });
  });

  it('restores a snapshot saved before windows could be shown in another tab\'s browser exactly as it did', () => {
    const store = new BrowserSessionStore();
    const old = store.createSession({ ...identity, profileId: 'work' });
    const saved = JSON.parse(JSON.stringify(old));
    delete saved.kernel;
    const restored = new BrowserSessionStore().restoreSession(saved);
    expect(restored).toMatchObject({ kernel: 'builtin', profileId: 'work', partition: browserPartitionForProfile(old, 'work') });
    // The partition is worked out again from the profile, never taken from the file: a profile that was removed falls back to the default one.
    const stale = new BrowserSessionStore().restoreSession({ ...saved, partition: 'persist:gugu-browser-profile-elsewhere' }, [{ id: 'default', name: 'Default' }]);
    expect(stale).toMatchObject({ profileId: 'default', partition: browserPartitionForProfile(old, 'default') });
  });
});

// #6264 别的机器上的网页:页签加载的是 gugu-preview 地址,地址栏要显示人要开的 file: 地址。
describe('BrowserSessionStore url presenter', () => {
  const present = (url: string) =>
    url.startsWith('gugu-preview://p1/') ? `file:///root/proj/${url.slice('gugu-preview://p1/'.length)}` : null;

  it('records the presented address for every url written in (navigation, load errors)', () => {
    const { store, browserId } = setup();
    store.setUrlPresenter(browserId, present);
    store.updateSession(browserId, { currentUrl: 'gugu-preview://p1/docs/b.html' });
    expect(store.getSession(browserId)?.currentUrl).toBe('file:///root/proj/docs/b.html');
    store.updateSession(browserId, { loadError: { description: 'x', url: 'gugu-preview://p1/c.html' } });
    expect(store.getSession(browserId)?.loadError?.url).toBe('file:///root/proj/c.html');
  });

  it('leaves other addresses alone, and stops presenting once removed', () => {
    const { store, browserId } = setup();
    store.setUrlPresenter(browserId, present);
    store.updateSession(browserId, { currentUrl: 'https://example.com/' });
    expect(store.getSession(browserId)?.currentUrl).toBe('https://example.com/');
    store.setUrlPresenter(browserId, null);
    store.updateSession(browserId, { currentUrl: 'http://localhost:3000/' });
    expect(store.getSession(browserId)?.currentUrl).toBe('http://localhost:3000/');
  });

  it('without a presenter an internal address never replaces the one shown (it is not a tab url)', () => {
    const { store, browserId } = setup();
    store.updateSession(browserId, { currentUrl: 'gugu-preview://p1/a.html' });
    expect(store.getSession(browserId)?.currentUrl).toBe('file:///root/proj/index.html');
  });
});
