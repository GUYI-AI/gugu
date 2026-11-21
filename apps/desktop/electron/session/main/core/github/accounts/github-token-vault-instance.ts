import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { log } from '@main/lib/logger';
import { moveGitHubTokensIntoVault, type GitHubTokenVault } from './github-accounts';

export const githubTokenVault: GitHubTokenVault = {
  save: async (input, credentialId) =>
    (await import('../../../../../password-vault/beta-host')).passwordVaultForHost.save(input, credentialId),
};

let moving: Promise<void> | null = null;

/** Run the upgrade move once per process; a failure is logged and the next GitHub read tries again. */
export function ensureGitHubTokensInVault(): Promise<void> {
  moving ??= moveGitHubTokensIntoVault(providerAccountRegistry, githubTokenVault).then(
    (moved) => {
      if (moved) log.info(`Moved ${moved} GitHub token(s) into the password vault`);
    },
    (error: unknown) => {
      moving = null;
      log.error('Moving GitHub tokens into the password vault failed; retrying on the next GitHub read', error);
    }
  );
  return moving;
}
