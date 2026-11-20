import type { ProviderAccount, ProviderAccountUpsert } from '@main/core/provider-accounts/provider-account-registry';
import { passwordVaultForHost, type SiteCredential } from '../../../../../password-vault/beta-host';
import {
  CONNECTOR_SUBJECT, GITHUB_AVATAR_FIELD, GITHUB_ID_FIELD, GITHUB_SOURCE_FIELD, githubCredentials, githubSite, rawGitHubCredentials,
} from '../github-credential';
import { GITHUB_PROVIDER_ID } from './github-accounts';
import { GITHUB_CREDENTIAL_SOURCES, type GitHubCredentialSource } from '@shared/github';

/**
 * The GitHub accounts, as the password vault keeps them: each is one saved GitHub credential (its id is the account id); the
 * default is the one the connector uses (`host:connector:github`). Same surface the GitHub code read from the provider
 * account registry before, minus any way to read a token: requests go through `vaultGitHubFetch`.
 */
const hostOf = (credential: SiteCredential) => new URL(credential.origin).hostname;
/** How it was connected, as one of the known sources: the vault's value is free text the person can edit. */
const sourceOf = (credential: SiteCredential): GitHubCredentialSource =>
  GITHUB_CREDENTIAL_SOURCES.find((source) => source === credential.fields[GITHUB_SOURCE_FIELD]) ?? 'vault';
const isConnector = (credential: SiteCredential) => credential.users.some((user) => user.subject === CONNECTOR_SUBJECT);

function asProviderAccount(credential: SiteCredential): ProviderAccount {
  return {
    providerId: GITHUB_PROVIDER_ID, accountId: credential.id, credentialRef: '', isDefault: isConnector(credential),
    meta: {
      version: '1',
      providerAccountId: credential.fields[GITHUB_ID_FIELD] ?? '', host: hostOf(credential), login: credential.account ?? credential.maskedAccount,
      avatarUrl: credential.fields[GITHUB_AVATAR_FIELD] ?? '', credentialSource: sourceOf(credential),
    },
    createdAt: Date.now(), updatedAt: Date.now(),
  };
}

export const githubVaultAccountStore = {
  async listAccounts(_providerId: string): Promise<ProviderAccount[]> {
    return (await githubCredentials()).map(asProviderAccount);
  },
  async getAccount(_providerId: string, accountId: string): Promise<ProviderAccount | null> {
    const found = (await githubCredentials()).find((credential) => credential.id === accountId);
    return found ? asProviderAccount(found) : null;
  },
  async getDefaultAccountId(_providerId: string): Promise<string | null> {
    return (await githubCredentials()).find((credential) => isConnector(credential) && hostOf(credential) === 'github.com')?.id
      ?? (await githubCredentials()).find(isConnector)?.id ?? null;
  },
  /** The connector uses this one on its website from now on. */
  async setDefaultAccount(_providerId: string, accountId: string): Promise<ProviderAccount | null> {
    const found = (await githubCredentials()).find((credential) => credential.id === accountId);
    if (!found) return null;
    await passwordVaultForHost.assign(CONNECTOR_SUBJECT, githubSite(hostOf(found)), found.id);
    return { ...asProviderAccount(found), isDefault: true };
  },
  /**
   * Disconnecting an account here stops the connector and every project using it; the credential stays in the vault
   * (deleting it is the vault's own screen).
   */
  async removeAccount(_providerId: string, accountId: string): Promise<ProviderAccount | null> {
    const found = (await githubCredentials()).find((credential) => credential.id === accountId);
    if (!found) return null;
    for (const user of found.users) await passwordVaultForHost.assign(user.subject, githubSite(hostOf(found)), null);
    return asProviderAccount(found);
  },
  /**
   * A token the person handed over (device flow, pasted): saved into the vault — over the credential of the same GitHub
   * user on that host, when there is one — and made the connector's when it has none on that website yet.
   */
  async upsertAccount(input: ProviderAccountUpsert): Promise<{ account: ProviderAccount; status: 'created' | 'updated' }> {
    const meta = input.meta ?? {};
    const host = githubSite(String(meta.host ?? 'github.com')), providerAccountId = String(meta.providerAccountId ?? '');
    if (!input.secret) throw new Error('A GitHub credential needs its token');
    const existing = (await rawGitHubCredentials()).find((credential) => hostOf(credential) === host && credential.fields[GITHUB_ID_FIELD] === providerAccountId);
    const id = await passwordVaultForHost.save({
      origin: `https://${host}`, name: 'GitHub', account: String(meta.login ?? ''), password: input.secret,
      fields: { [GITHUB_ID_FIELD]: providerAccountId, [GITHUB_AVATAR_FIELD]: String(meta.avatarUrl ?? ''), [GITHUB_SOURCE_FIELD]: String(meta.credentialSource ?? 'device_flow') },
    }, existing?.id);
    const saved = (await rawGitHubCredentials()).find((credential) => credential.id === id);
    if (!saved) throw new Error('The GitHub credential was saved but cannot be read back');
    if (!(await rawGitHubCredentials()).some((credential) => isConnector(credential) && githubSite(hostOf(credential)) === host)) {
      await passwordVaultForHost.assign(CONNECTOR_SUBJECT, host, id);
    }
    const account = asProviderAccount((await rawGitHubCredentials()).find((credential) => credential.id === id) ?? saved);
    return { account, status: existing ? 'updated' : 'created' };
  },
};
export type GitHubVaultAccountStore = typeof githubVaultAccountStore;
