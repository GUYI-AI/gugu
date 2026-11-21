import { vaultCredentialOf } from '@main/core/provider-accounts/provider-account-registry';
import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { log } from '@main/lib/logger';
import { GITHUB_PROVIDER_ID, moveGitHubTokensIntoVault, toGitHubAccount, type GitHubTokenVault } from './github-accounts';

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

/** The vault credential behind the connector's default GitHub account on `site`, if its token is kept there. */
export async function githubDefaultCredential(site: string): Promise<string | null> {
  await ensureGitHubTokensInVault();
  const defaultId = await providerAccountRegistry.getDefaultAccountId(GITHUB_PROVIDER_ID);
  const row = defaultId ? await providerAccountRegistry.getAccount(GITHUB_PROVIDER_ID, defaultId) : null;
  if (!row || toGitHubAccount(row).host !== site) return null;
  return vaultCredentialOf(row.credentialRef);
}
