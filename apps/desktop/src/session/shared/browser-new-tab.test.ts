import { describe, expect, it } from 'vitest';
import {
  BROWSER_ISOLATED_PROFILE_ID,
  browserPartitionForProfile,
  browserProfilePartition,
  createBrowserSessionSnapshot,
  isIsolatedBrowserPartition,
  makeBrowserSessionIdentity,
  newTabSharesPartition,
  profileForNewTab,
} from './browser';

const identity = makeBrowserSessionIdentity({ projectId: 'p1', workspaceId: 'w1', sessionId: 's1' });

describe('which tabs share a browser (partition) with the tab a link was clicked in', () => {
  it('a new tab opens in the default profile: the same partition only for a tab that is on that profile', () => {
    const onDefault = browserPartitionForProfile(identity, 'default');
    const onWork = browserPartitionForProfile(identity, 'work');
    expect(newTabSharesPartition(onDefault, 'default')).toBe(true);
    expect(newTabSharesPartition(onWork, 'work')).toBe(true);
    expect(newTabSharesPartition(onWork, 'default')).toBe(false);
    expect(newTabSharesPartition(onDefault, 'work')).toBe(false);
  });

  it('a tab on a profile never shares with an isolated session browser, either way round', () => {
    const isolated = browserPartitionForProfile(identity, BROWSER_ISOLATED_PROFILE_ID);
    expect(isIsolatedBrowserPartition(isolated)).toBe(true);
    expect(newTabSharesPartition(isolated, 'default')).toBe(false);
    expect(newTabSharesPartition(browserProfilePartition('default'), BROWSER_ISOLATED_PROFILE_ID)).toBe(false);
    expect(newTabSharesPartition(browserProfilePartition('work'), BROWSER_ISOLATED_PROFILE_ID)).toBe(false);
  });

  it('with isolated as the default, a new tab shares the isolated browser of the session it opens in', () => {
    const isolated = browserPartitionForProfile(identity, BROWSER_ISOLATED_PROFILE_ID);
    expect(newTabSharesPartition(isolated, BROWSER_ISOLATED_PROFILE_ID)).toBe(true);
  });

  it('a profile that is named like an isolated one is not mistaken for it', () => {
    expect(isIsolatedBrowserPartition(browserProfilePartition('isolated-x'))).toBe(false);
    expect(isIsolatedBrowserPartition(browserProfilePartition('default'))).toBe(false);
  });
});

describe('the profile and partition of a new tab', () => {
  const settings = { defaultProfileId: 'work', profiles: [{ id: 'work', name: 'Work' }, { id: 'default', name: 'Default' }] };

  it('opens in the profile chosen in Settings and works its partition out from the tab\'s own identity, as every tab did before', () => {
    expect(profileForNewTab(settings)).toStrictEqual({ profileId: 'work' });
    expect(profileForNewTab({ defaultProfileId: BROWSER_ISOLATED_PROFILE_ID })).toStrictEqual({ profileId: BROWSER_ISOLATED_PROFILE_ID });
    expect(profileForNewTab(undefined)).toStrictEqual({ profileId: 'default' });
    expect(profileForNewTab({ defaultProfileId: 'gone', profiles: [{ id: 'work', name: 'Work' }] })).toStrictEqual({ profileId: 'work' });
    const tab = createBrowserSessionSnapshot({ identity, ...profileForNewTab({ defaultProfileId: BROWSER_ISOLATED_PROFILE_ID }) });
    expect(tab.partition).toBe(browserPartitionForProfile(identity, BROWSER_ISOLATED_PROFILE_ID));
  });

  it('is the profile and partition of the page\'s tab when the tab shows a window that tab\'s Chrome made, whatever Settings says', () => {
    const windowOf = { profileId: BROWSER_ISOLATED_PROFILE_ID, partition: browserPartitionForProfile(identity, BROWSER_ISOLATED_PROFILE_ID) };
    expect(profileForNewTab(settings, windowOf)).toStrictEqual(windowOf);
    const tab = createBrowserSessionSnapshot({ identity: { ...identity, browserId: 'other' }, ...profileForNewTab(settings, windowOf) });
    expect(tab).toMatchObject({ profileId: BROWSER_ISOLATED_PROFILE_ID, partition: windowOf.partition });
  });

  it('keeps the partition it is told to, even for an identity that would work out another one', () => {
    const elsewhere = makeBrowserSessionIdentity({ projectId: 'p1', workspaceId: 'w1', sessionId: 'another-session' });
    const told = browserPartitionForProfile(identity, BROWSER_ISOLATED_PROFILE_ID);
    expect(createBrowserSessionSnapshot({ identity: elsewhere, profileId: BROWSER_ISOLATED_PROFILE_ID, partition: told }).partition).toBe(told);
    expect(createBrowserSessionSnapshot({ identity: elsewhere, profileId: BROWSER_ISOLATED_PROFILE_ID }).partition).toBe(browserPartitionForProfile(elsewhere, BROWSER_ISOLATED_PROFILE_ID));
  });
});
