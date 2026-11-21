import { describe, expect, it, vi } from 'vitest';
import { standaloneBrowserCredentialStore } from './standalone-browser-launch-policy';
import { taskBrowserArguments } from '../../../../server/server-task-browser';

// Launch arguments do not depend on renderer localization.
vi.mock('@/i18n/locale', () => ({ FALLBACK_LOCALE: 'en' }));

describe('standalone browser credential storage', () => {
  it('uses system storage unless a development test explicitly opts in', () => {
    expect(standaloneBrowserCredentialStore({}, false)).toBe('system');
    expect(standaloneBrowserCredentialStore({ GUGU_TEST_MODE: '1' }, false)).toBe('system');
    expect(standaloneBrowserCredentialStore({ GUGU_STANDALONE_TEST_KEYCHAIN: 'basic' }, false)).toBe('system');
    expect(standaloneBrowserCredentialStore({ GUGU_TEST_MODE: '1', GUGU_STANDALONE_TEST_KEYCHAIN: 'basic' }, false)).toBe('basic');
  });
  it('always launches an installed macOS standalone browser with the mock keychain, without test overrides', () => {
    for (const env of [{}, { GUGU_TEST_MODE: '0', GUGU_STANDALONE_TEST_KEYCHAIN: 'system' }]) {
      const storage = standaloneBrowserCredentialStore(env, true, 'darwin');
      const args = taskBrowserArguments('/isolated/standalone', 'UA', false, storage, { automationControlled: false });
      expect(args).toContain('--use-mock-keychain');
      expect(args).toContain('--user-data-dir=/isolated/standalone');
    }
  });
  it.each(['linux', 'win32'] as const)('keeps installed %s storage on the system store, including with test overrides', platform => {
    for (const env of [{}, { GUGU_TEST_MODE: '1', GUGU_STANDALONE_TEST_KEYCHAIN: 'basic' }]) {
      const storage = standaloneBrowserCredentialStore(env, true, platform);
      expect(storage).toBe('system');
      expect(taskBrowserArguments('/isolated/standalone', 'UA', false, storage)).not.toContain('--use-mock-keychain');
    }
  });
});
