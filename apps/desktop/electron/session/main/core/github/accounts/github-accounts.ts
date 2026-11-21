import {
  vaultCredentialOf,
  vaultCredentialRef,
  type ProviderAccount,
  type ProviderAccountRegistry,
} from '@main/core/provider-accounts/provider-account-registry';
import type { GitHubTokenSource } from '@shared/github';
import { normalizeRepositoryHost } from '@shared/repository-ref';

export const GITHUB_PROVIDER_ID = 'github';

export type GitHubAccountCredentialSource = Exclude<GitHubTokenSource, null>;

export type GitHubProviderAccount = {
  providerId: 'github';
  providerAccountId: string;
  host: string;
  login: string;
  avatarUrl: string;
};

/** Flat GitHub-shaped view over a generic provider account row. */
export type GitHubAccount = {
  id: string;
  providerAccountId: string;
  host: string;
  login: string;
  avatarUrl: string;
  credentialSource: GitHubAccountCredentialSource;
  connectedAt: number;
  updatedAt: number;
};

export type GitHubAccountUpsert = {
  /**
   * Omit when another holder owns the token (gh CLI): only identity metadata is
   * written and no secret is stored. Sources with no other holder — device flow,
   * platform OAuth — must pass it.
   */
  accessToken?: string;
  credentialSource: GitHubAccountCredentialSource;
  providerAccount: GitHubProviderAccount;
};

export type GitHubAccountUpsertResult = {
  account: GitHubAccount;
  status: 'created' | 'updated';
};

/** The generic registry surface GitHub code depends on. */
export type GitHubAccountStore = Pick<
  ProviderAccountRegistry,
  | 'upsertAccount'
  | 'listAccounts'
  | 'getAccount'
  | 'getDefaultAccountId'
  | 'setDefaultAccount'
  | 'resolveSecret'
  | 'clearSecret'
  | 'removeAccount'
  | 'relocateSecret'
>;

/** Where a token the person handed over is kept: their password vault, one credential per account (`passwordVaultForHost`). */
export type GitHubTokenVault = {
  save(input: { origin: string; name: string; account: string; password: string }, credentialId?: string): Promise<string>;
};

export function normalizeGitHubHost(host: string): string {
  return normalizeRepositoryHost(host) || 'github.com';
}

/** Map a generic provider account to the flat GitHub shape. */
export function toGitHubAccount(account: ProviderAccount): GitHubAccount {
  // accountId convention is `${host}:${providerAccountId}`; used as a fallback
  // for rows whose meta is missing or unreadable.
  const separator = account.accountId.lastIndexOf(':');
  const fallbackHost = separator > 0 ? account.accountId.slice(0, separator) : 'github.com';
  const fallbackProviderAccountId =
    separator > 0 ? account.accountId.slice(separator + 1) : account.accountId;

  return {
    id: account.accountId,
    providerAccountId: account.meta?.providerAccountId ?? fallbackProviderAccountId,
    host: account.meta?.host ?? fallbackHost,
    login: account.meta?.login ?? '',
    avatarUrl: account.meta?.avatarUrl ?? '',
    credentialSource:
      (account.meta?.credentialSource as GitHubAccountCredentialSource | undefined) ??
      'secure_storage',
    connectedAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

/**
 * Store a GitHub account in the generic provider account registry: constructs
 * the `${host}:${providerAccountId}` account id and maps the identity fields
 * into the generic meta blob. A token goes into the password vault (over this
 * account's credential there, when it has one) and the row points at it.
 */
export async function upsertGitHubAccount(
  store: Pick<GitHubAccountStore, 'upsertAccount' | 'getAccount' | 'relocateSecret'>,
  input: GitHubAccountUpsert,
  tokens?: GitHubTokenVault
): Promise<GitHubAccountUpsertResult> {
  const host = normalizeGitHubHost(input.providerAccount.host);
  const accountId = `${host}:${input.providerAccount.providerAccountId}`;
  const existing = await store.getAccount(GITHUB_PROVIDER_ID, accountId);
  let credentialRef: string | undefined;
  if (input.accessToken !== undefined) {
    if (!tokens) throw new Error('A GitHub token is kept in the password vault, which this caller did not pass');
    const previous = existing ? vaultCredentialOf(existing.credentialRef) ?? undefined : undefined;
    credentialRef = vaultCredentialRef(await tokens.save(
      { origin: `https://${host}`, name: 'GitHub', account: input.providerAccount.login, password: input.accessToken },
      previous
    ));
  }
  const { account, status } = await store.upsertAccount({
    providerId: GITHUB_PROVIDER_ID,
    accountId,
    ...(credentialRef ? { credentialRef } : {}),
    meta: {
      providerAccountId: input.providerAccount.providerAccountId,
      host,
      login: input.providerAccount.login,
      avatarUrl: input.providerAccount.avatarUrl,
      credentialSource: input.credentialSource,
    },
  });
  // An account that had its token elsewhere (the app's store, or none) now points at the vault's.
  if (credentialRef && account.credentialRef !== credentialRef) {
    await store.relocateSecret(GITHUB_PROVIDER_ID, accountId, credentialRef);
    return { account: toGitHubAccount({ ...account, credentialRef }), status };
  }
  return { account: toGitHubAccount(account), status };
}

/**
 * Upgrade: a GitHub token the app's own store kept moves into the vault, and its row points at it. gh-sourced rows
 * hold no token and stay. Until a row moves its token is where its ref says, so a failed or partial run leaves every
 * account working and the next run carries on. Returns how many moved.
 */
export async function moveGitHubTokensIntoVault(
  store: Pick<GitHubAccountStore, 'listAccounts' | 'resolveSecret' | 'relocateSecret'>,
  tokens: GitHubTokenVault
): Promise<number> {
  let moved = 0;
  for (const row of await store.listAccounts(GITHUB_PROVIDER_ID)) {
    if (vaultCredentialOf(row.credentialRef)) continue;
    const account = toGitHubAccount(row);
    if (account.credentialSource === 'cli') continue;
    const token = await store.resolveSecret(GITHUB_PROVIDER_ID, row.accountId);
    if (!token) continue;
    const credentialId = await tokens.save({ origin: `https://${account.host}`, name: 'GitHub', account: account.login, password: token });
    await store.relocateSecret(GITHUB_PROVIDER_ID, row.accountId, vaultCredentialRef(credentialId));
    moved += 1;
  }
  return moved;
}
