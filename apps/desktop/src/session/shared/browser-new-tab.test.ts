import { describe, expect, it } from 'vitest';
import {
  BROWSER_ISOLATED_PROFILE_ID,
  browserPartitionForProfile,
  browserProfilePartition,
  isIsolatedBrowserPartition,
  makeBrowserSessionIdentity,
  newTabSharesPartition,
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
