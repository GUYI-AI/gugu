import { describe, expect, it } from 'vitest';
import { createBrowserSessionSnapshot, makeBrowserSessionIdentity } from '@shared/browser';
import { newTabArgs } from './browser-new-tab-args';

const source = createBrowserSessionSnapshot({ identity: makeBrowserSessionIdentity({ projectId: 'p', workspaceId: 'w', sessionId: 's' }), profileId: 'work', kernel: 'standalone' });

describe('how a sibling tab is opened for a window a page opened', () => {
  it('opens a tab with its address alone when no window was made for it, whatever the page\'s tab is: the built-in browser always', () => {
    expect(newTabArgs({ url: 'https://site.test/a' }, source)).toStrictEqual({ initialUrl: 'https://site.test/a' });
    expect(newTabArgs({ url: 'https://site.test/a' }, undefined)).toStrictEqual({ initialUrl: 'https://site.test/a' });
    expect(newTabArgs({ url: 'https://site.test/a', popup: undefined }, source)).toStrictEqual({ initialUrl: 'https://site.test/a' });
  });

  it('opens the tab of a window the standalone Chrome made in the profile and partition of the page\'s tab', () => {
    expect(newTabArgs({ url: 'https://github.com/login', popup: 'P1' }, source)).toStrictEqual({
      initialUrl: 'https://github.com/login',
      popup: 'P1',
      windowOf: { profileId: 'work', partition: source.partition },
    });
  });

  it('still names the window when the page\'s tab is gone, and says nothing about a profile it cannot know', () => {
    expect(newTabArgs({ url: 'https://github.com/login', popup: 'P1' }, undefined)).toStrictEqual({ initialUrl: 'https://github.com/login', popup: 'P1' });
  });
});
