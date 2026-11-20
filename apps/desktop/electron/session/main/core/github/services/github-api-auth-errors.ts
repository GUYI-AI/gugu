import { isGitHubDotComHost } from '@shared/repository-ref';
import { VaultError } from '../../../../../password-vault/contracts';

export type GitHubApiAuthError =
  | {
      type: 'auth_required';
      host: string;
      message: string;
      hint?: string;
    }
  | {
      type: 'account_not_found';
      host: string;
      accountId: string;
      message: string;
      hint?: string;
    }
  | {
      type: 'account_host_mismatch';
      host: string;
      accountId: string;
      accountHost: string;
      message: string;
      hint?: string;
    }
  | {
      type: 'token_missing';
      host: string;
      accountId: string;
      message: string;
      hint?: string;
    };

function authHint(host: string): string {
  return isGitHubDotComHost(host)
    ? 'Connect GitHub (or paste a token) in Connectors › GitHub.'
    : `Paste a token for ${host} in Connectors › GitHub.`;
}

export function githubApiAuthRequired(host: string): GitHubApiAuthError {
  if (isGitHubDotComHost(host)) {
    return {
      type: 'auth_required',
      host,
      message: 'GitHub authentication required. Connect GitHub (or paste a token) in Connectors › GitHub.',
      hint: authHint(host),
    };
  }
  const hint = authHint(host);
  return {
    type: 'auth_required',
    host,
    message: `GitHub Enterprise authentication required for ${host}. ${hint}`,
    hint,
  };
}

export function githubApiAccountNotFound(host: string, accountId: string): GitHubApiAuthError {
  return {
    type: 'account_not_found',
    host,
    accountId,
    message: `Selected GitHub account is no longer connected: ${accountId}.`,
    hint: authHint(host),
  };
}

export function githubApiAccountHostMismatch(
  host: string,
  accountId: string,
  accountHost: string
): GitHubApiAuthError {
  return {
    type: 'account_host_mismatch',
    host,
    accountId,
    accountHost,
    message: `Selected GitHub account ${accountId} is for ${accountHost}, but this repository uses ${host}.`,
    hint: authHint(host),
  };
}

/** The vault could not be used for this account (its reason, said as it is). */
export function githubApiTokenMissing(host: string, accountId: string, reason?: string): GitHubApiAuthError {
  return {
    type: 'token_missing',
    host,
    accountId,
    message: reason ?? `Selected GitHub account ${accountId} is missing a saved token.`,
    hint: authHint(host),
  };
}

/** The vault's failure, said as what it is (fail loud: no request goes out without the person's GitHub credential). */
export function vaultProblem(error: unknown): string | null {
  // A VaultError as thrown, or as it arrives serialized past a Result boundary (its name and code kept).
  const thrown = error as { name?: unknown; code?: unknown } | null | undefined;
  if (!(error instanceof VaultError) && thrown?.name !== 'VaultError') return null;
  if (thrown?.code === 'SYSTEM_STORAGE_UNAVAILABLE') return 'This computer\'s system key storage is unavailable, so the saved GitHub credential cannot be used. On Linux, install or unlock the system keyring (GNOME Keyring / KWallet).';
  if (thrown?.code === 'NOT_GRANTED') return 'No saved GitHub credential is chosen: connect GitHub or pick one in Connectors › GitHub.';
  return `The password vault is unavailable (${String(thrown?.code)}).`;
}
