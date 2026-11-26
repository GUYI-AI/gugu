import { mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** agy 1.5 bypasses the shared OS keyring in SSH mode. Apply only to an explicitly saved account.
 * https://github.com/google-antigravity/antigravity-cli/issues/1610
 * The native CLI account keeps its existing storage and environment.
 */
export const ANTIGRAVITY_ACCOUNT_ENV = { SSH_CONNECTION: '127.0.0.1 1 127.0.0.1 2' } as const;

/** Keep native history and customizations in the managed root; each account owns only its sign-in/settings. */
export async function ensureAntigravityVault(root: string, managed: string): Promise<void> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  for (const relative of ['config', 'skills']) await share(relative);
  for (const product of ['antigravity-cli', 'antigravity-acp']) {
    await mkdir(join(root, product), { recursive: true, mode: 0o700 });
    for (const entry of ['conversations', 'brain']) await share(`${product}/${entry}`);
  }
  // A new subscription account must not inherit an API-key provider selection.
  await writeFile(join(root, 'antigravity-cli/settings.json'), '{}\n', { flag: 'wx', mode: 0o600 })
    .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  async function share(relative: string) {
    const source = join(managed, relative);
    await mkdir(source, { recursive: true, mode: 0o700 });
    await symlink(source, join(root, relative), process.platform === 'win32' ? 'junction' : 'dir')
      .catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
  }
}

export async function antigravitySignInSaved(root: string): Promise<boolean> {
  try {
    const stored = JSON.parse(await readFile(join(root, 'antigravity-cli/antigravity-oauth-token'), 'utf8'));
    return typeof stored?.token?.refresh_token === 'string' && !!stored.token.refresh_token.trim();
  } catch { return false; }
}
