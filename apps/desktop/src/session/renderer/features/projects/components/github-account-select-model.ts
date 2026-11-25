import type { GitHubAccountSummary } from '@shared/github';

export type RequiredGitHubAccountSelectState = {
  accounts: GitHubAccountSummary[];
  selectedAccount: GitHubAccountSummary | null;
  selectedAccountId: string | null;
};

export function sortGitHubAccountsByDefault(
  accounts: GitHubAccountSummary[]
): GitHubAccountSummary[] {
  return [...accounts].sort((a, b) => Number(b.isDefault) - Number(a.isDefault));
}
