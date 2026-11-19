/** Test-only storage override. Installed applications always retain the system keychain. */
export function standaloneBrowserCredentialStore(env: NodeJS.ProcessEnv, packaged: boolean): 'basic' | 'system' {
  return !packaged && env.GUGU_TEST_MODE === '1' && env.GUGU_STANDALONE_TEST_KEYCHAIN === 'basic' ? 'basic' : 'system';
}
