import type { GitHubAccountSummary } from '@shared/github';
import {
  GITHUB_PROVIDER_ID,
  toGitHubAccount,
  type GitHubAccount,
} from './github-accounts';
import type { GitHubVaultAccountStore } from './github-vault-accounts';

type GitHubAccountServiceStore = Pick<
  GitHubVaultAccountStore,
  'listAccounts' | 'getDefaultAccountId' | 'setDefaultAccount' | 'removeAccount'
>;

export class GitHubAccountService {
  constructor(
    private readonly accountStore: GitHubAccountServiceStore,
    private readonly clearCachedClients: () => void = () => {}
  ) {}

  async listAccounts(): Promise<GitHubAccountSummary[]> {
    const [accounts, defaultAccountId] = await Promise.all([
      this.accountStore.listAccounts(GITHUB_PROVIDER_ID),
      this.accountStore.getDefaultAccountId(GITHUB_PROVIDER_ID),
    ]);
    return accounts
      .map(toGitHubAccount)
      .map((account) => this.toAccountSummary(account, defaultAccountId));
  }

  async setDefaultAccount(accountId: string): Promise<GitHubAccountSummary | null> {
    const account = await this.accountStore.setDefaultAccount(GITHUB_PROVIDER_ID, accountId);
    if (!account) return null;
    this.clearCachedClients();
    return this.toAccountSummary(toGitHubAccount(account), account.accountId);
  }

  async removeAccount(accountId: string): Promise<GitHubAccountSummary[] | null> {
    const removed = await this.accountStore.removeAccount(GITHUB_PROVIDER_ID, accountId);
    if (!removed) return null;

    this.clearCachedClients();
    return this.listAccounts();
  }

  private toAccountSummary(
    account: GitHubAccount,
    defaultAccountId: string | null
  ): GitHubAccountSummary {
    return {
      accountId: account.id,
      host: account.host,
      login: account.login,
      avatarUrl: account.avatarUrl,
      credentialSource: account.credentialSource,
      isDefault: account.id === defaultAccountId,
    };
  }
}
