/** Credential storage for the standalone process only; the built-in Electron browser is unaffected. */
export function standaloneBrowserCredentialStore(
  env: NodeJS.ProcessEnv, packaged: boolean, platform: NodeJS.Platform = process.platform,
): 'basic' | 'system' {
  // owner 11-21: avoid macOS Keychain prompts from the downloaded standalone browser.
  // Trade-off: Chromium's mock uses a public test secret, so cookies and saved passwords
  // lose system Keychain protection; profile file permissions still apply. Other platforms keep their policy.
  if (packaged && platform === 'darwin') return 'basic';
  return !packaged && env.GUGU_TEST_MODE === '1' && env.GUGU_STANDALONE_TEST_KEYCHAIN === 'basic' ? 'basic' : 'system';
}
