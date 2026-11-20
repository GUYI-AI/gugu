import { err, ok, type Result } from '@gugu/session-shared';
import { normalizeRepositoryHost } from '@shared/repository-ref';
import { toGitHubAccount, type GitHubAccount } from '../accounts/github-accounts';
import type { GitHubVaultAccountStore } from '../accounts/github-vault-accounts';
import { CONNECTOR_SUBJECT, grantedCredential, projectSubject, vaultGitHubFetch } from '../github-credential';
import {
  githubApiAccountHostMismatch,
  githubApiAccountNotFound,
  githubApiAuthRequired,
  githubApiTokenMissing,
  vaultProblem,
  type GitHubApiAuthError,
} from './github-api-auth-errors';

/**
 * Whose GitHub credential a request uses: one the person is picking on a screen right now (`accountId`), the one a project
 * chose (`projectId`, its `host:github:project:<id>` grant), else the connector's current one.
 */
export type GitHubApiAuthContext = {
  accountId?: string;
  projectId?: string;
};

/** A GitHub host's requests, sent by the password vault with the chosen credential (`vaultGitHubFetch`). */
export type GitHubRequestAuth = { fetch: typeof fetch; account: GitHubAccount; cacheKey: string };

export class GitHubApiAuthService {
  constructor(private readonly accounts: Pick<GitHubVaultAccountStore, 'listAccounts'>) {}

  async resolve(host: string, context: GitHubApiAuthContext = {}): Promise<Result<GitHubRequestAuth, GitHubApiAuthError>> {
    const normalizedHost = normalizeRepositoryHost(host);
    let accounts: GitHubAccount[];
    try { accounts = (await this.accounts.listAccounts('github')).map(toGitHubAccount); }
    catch (error) { return err(githubApiTokenMissing(normalizedHost, context.accountId ?? '', vaultProblem(error) ?? String(error))); }
    const accountId = context.accountId?.trim();
    if (accountId) {
      const account = accounts.find((candidate) => candidate.id === accountId);
      if (!account) return err(githubApiAccountNotFound(normalizedHost, accountId));
      if (normalizeRepositoryHost(account.host) !== normalizedHost) return err(githubApiAccountHostMismatch(normalizedHost, account.id, account.host));
      return ok({ fetch: vaultGitHubFetch(normalizedHost, { credentialId: account.id }), account, cacheKey: `${normalizedHost}:account:${account.id}` });
    }
    let subject = CONNECTOR_SUBJECT;
    try {
      if (context.projectId && await grantedCredential(normalizedHost, projectSubject(context.projectId))) subject = projectSubject(context.projectId);
      const chosen = await grantedCredential(normalizedHost, subject);
      const account = chosen && accounts.find((candidate) => candidate.id === chosen.id);
      if (!account) return err(githubApiAuthRequired(normalizedHost));
      return ok({ fetch: vaultGitHubFetch(normalizedHost, { subject }), account, cacheKey: `${normalizedHost}:${subject}:${account.id}` });
    } catch (error) {
      return err(githubApiTokenMissing(normalizedHost, '', vaultProblem(error) ?? String(error)));
    }
  }
}
