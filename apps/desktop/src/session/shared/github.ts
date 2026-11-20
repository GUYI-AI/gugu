export interface GitHubUser {
  id: number;
  login: string;
  name: string;
  email: string;
  avatar_url: string;
}

export const GITHUB_CREDENTIAL_SOURCES = ['secure_storage', 'cli', 'emdash_oauth', 'device_flow', 'pat', 'vault'] as const;
export type GitHubTokenSource = (typeof GITHUB_CREDENTIAL_SOURCES)[number] | null;

export type GitHubCredentialSource = Exclude<GitHubTokenSource, null>;

export interface GitHubAccountSummary {
  accountId: string;
  host: string;
  login: string;
  avatarUrl: string;
  credentialSource: GitHubCredentialSource;
  isDefault: boolean;
}

export type GitHubAccountState = {
  connected: boolean;
  accounts: GitHubAccountSummary[];
  defaultAccountId: string | null;
  /** The accounts could not be read (the password vault, or moving old accounts into it): what to tell the person. */
  error?: string;
};

export type GitHubSetDefaultAccountResponse =
  | { success: true; account: GitHubAccountSummary }
  | { success: false; error: string };

export type GitHubRemoveAccountResponse =
  | { success: true; accounts: GitHubAccountSummary[] }
  | { success: false; error: string };

export type GitHubAuthResponse =
  | { success: true; account: GitHubAccountSummary; user?: GitHubUser }
  | { success: false; error: string };
