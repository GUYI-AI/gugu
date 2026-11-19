import { describe, expect, it } from 'vitest';
import { standaloneBrowserCredentialStore } from './standalone-browser-launch-policy';

describe('standalone browser credential storage', () => {
  it('uses system storage unless a development test explicitly opts in', () => {
    expect(standaloneBrowserCredentialStore({}, false)).toBe('system');
    expect(standaloneBrowserCredentialStore({ GUGU_TEST_MODE: '1' }, false)).toBe('system');
    expect(standaloneBrowserCredentialStore({ GUGU_STANDALONE_TEST_KEYCHAIN: 'basic' }, false)).toBe('system');
    expect(standaloneBrowserCredentialStore({ GUGU_TEST_MODE: '1', GUGU_STANDALONE_TEST_KEYCHAIN: 'basic' }, false)).toBe('basic');
  });
  it('ignores the test override in an installed application', () => {
    expect(standaloneBrowserCredentialStore({ GUGU_TEST_MODE: '1', GUGU_STANDALONE_TEST_KEYCHAIN: 'basic' }, true)).toBe('system');
  });
});
