import { providerAccountRegistry } from '@main/core/provider-accounts/provider-account-registry-instance';
import { log } from '@main/lib/logger';
import { GITHUB_PROVIDER_ID, toGitHubAccount } from './accounts/github-accounts';
import { githubVaultAccountStore } from './accounts/github-vault-accounts';
import { CONNECTOR_SUBJECT, GITHUB_ID_FIELD, githubCredentials, githubSite, projectSubject } from './github-credential';
import { passwordVaultForHost } from '../../../../password-vault/beta-host';

/**
 * GitHub accounts kept before the password vault held them (provider accounts + their encrypted secrets) move into the vault
 * once: each token becomes a GitHub credential, the old default the connector's current one; then the old rows and secrets
 * go. Fail loud: when a move fails, the error stays here for the connector to show (with its repair: connect or paste
 * again) and nothing reads the old store any more. Accounts imported from `gh` kept no token here: nothing to move.
 */
let moved: Promise<void> | null = null;
export function migrateLegacyGitHubAccounts(): Promise<void> {
  moved ??= move().catch((error: unknown) => { moved = null; throw error; });
  return moved;
}

async function move(): Promise<void> {
  const rows = await providerAccountRegistry.listAccounts(GITHUB_PROVIDER_ID);
  if (!rows.length) return;
  const legacyDefault = await providerAccountRegistry.getDefaultAccountId(GITHUB_PROVIDER_ID);
  const failures: string[] = [];
  for (const row of rows) {
    const account = toGitHubAccount(row);
    try {
      const secret = account.credentialSource === 'cli' ? null : await providerAccountRegistry.resolveSecret(GITHUB_PROVIDER_ID, row.accountId);
      if (secret) {
        const { account: saved } = await githubVaultAccountStore.upsertAccount({ providerId: GITHUB_PROVIDER_ID, accountId: row.accountId, secret,
          meta: { providerAccountId: account.providerAccountId, host: account.host, login: account.login, avatarUrl: account.avatarUrl, credentialSource: account.credentialSource } });
        if (row.accountId === legacyDefault) await passwordVaultForHost.assign(CONNECTOR_SUBJECT, githubSite(account.host), saved.accountId);
      }
      await providerAccountRegistry.removeAccount(GITHUB_PROVIDER_ID, row.accountId);
    } catch (error) {
      failures.push(`${account.login || row.accountId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    log.warn('GitHub accounts could not move into the password vault', { failures: failures.length });
    throw new Error(`Some GitHub accounts could not move into the password vault — connect GitHub or paste a token again in Connectors › GitHub (${failures.join('; ')})`);
  }
}

/**
 * A project that picked an account before the vault (`settings.githubAccountId` naming `<host>:<GitHub id>`): the same
 * account's vault credential becomes the project's pick. Answers whether the old field can go.
 */
export async function migrateProjectGitHubAccount(projectId: string, legacyAccountId: string): Promise<boolean> {
  await migrateLegacyGitHubAccounts();
  const separator = legacyAccountId.lastIndexOf(':');
  const host = separator > 0 ? legacyAccountId.slice(0, separator) : 'github.com', githubId = legacyAccountId.slice(separator + 1);
  const credential = (await githubCredentials()).find((item) => item.id === legacyAccountId
    || new URL(item.origin).hostname === githubSite(host) && item.fields[GITHUB_ID_FIELD] === githubId);
  if (!credential) return false;
  await passwordVaultForHost.assign(projectSubject(projectId), githubSite(host), credential.id);
  return true;
}
