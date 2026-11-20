import type { GitHubAccountSummary } from '@shared/github';
import { isGitHubDotComHost } from '@shared/repository-ref';
import { githubAccountService } from './accounts/github-account-service-instance';
import { githubVaultAccountStore } from './accounts/github-vault-accounts';
import { GITHUB_PROVIDER_ID } from './accounts/github-accounts';
import { githubSite } from './github-credential';
import { githubApiBaseUrlForHost } from './services/github-api-base-url';

/**
 * 「粘贴令牌」: a token the person pasted becomes a GitHub credential in the vault. GitHub says whose it is first (GET /user),
 * so a wrong or expired token is refused here, never saved.
 */
export async function saveGitHubToken(host: string, token: string): Promise<GitHubAccountSummary> {
  const site = githubSite(host), trimmed = token.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error('Paste the token alone, without spaces');
  const response = await fetch(`${githubApiBaseUrlForHost(site)}/user`, {
    headers: { Authorization: `Bearer ${trimmed}`, Accept: 'application/vnd.github+json' }, redirect: 'manual',
  });
  if (response.status === 401) throw new Error(`${isGitHubDotComHost(site) ? 'GitHub' : site} does not accept this token`);
  if (!response.ok) throw new Error(`${site} answered ${response.status} when asked whose token this is`);
  const user = await response.json() as { id: number; login: string; avatar_url?: string };
  const { account } = await githubVaultAccountStore.upsertAccount({ providerId: GITHUB_PROVIDER_ID, accountId: `${site}:${user.id}`, secret: trimmed,
    meta: { providerAccountId: String(user.id), host: site, login: user.login, avatarUrl: user.avatar_url ?? '', credentialSource: 'pat' } });
  const summary = (await githubAccountService.listAccounts()).find((entry) => entry.accountId === account.accountId);
  if (!summary) throw new Error('The token was saved but its account cannot be read back');
  return summary;
}
