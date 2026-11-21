import { describe, expect, it } from 'vitest';
import { headlessViewerArgs } from './headless-viewer';

describe('headless observer browser arguments', () => {
  it('stays off the OS keychain, headless, autoplaying, on its own profile, and opens only the given page last', () => {
    const args = headlessViewerArgs('/tmp/profile', 'http://127.0.0.1:1234');
    expect(args).toEqual(expect.arrayContaining(['--headless=new', '--use-mock-keychain', '--autoplay-policy=no-user-gesture-required', '--user-data-dir=/tmp/profile']));
    expect(args.at(-1)).toBe('http://127.0.0.1:1234');
    expect(args.filter(arg => !arg.startsWith('--'))).toEqual(['http://127.0.0.1:1234']);
  });
});
