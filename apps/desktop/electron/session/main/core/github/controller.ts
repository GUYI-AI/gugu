import { Result } from '@gugu/session-shared/result';
import { githubAccountService } from '@main/core/github/accounts/github-account-service-instance';
import { githubDeviceFlowService } from '@main/core/github/services/github-device-flow-service-instance';
import { repoService } from '@main/core/github/services/repo-service';
import { vaultProblem } from '@main/core/github/services/github-api-auth-errors';
import { events } from '@main/lib/events';
import { log } from '@main/lib/logger';
import { githubAuthErrorChannel, githubAuthSuccessChannel } from '@shared/events/githubEvents';
import type {
  GitHubAccountState,
  GitHubAccountSummary,
  GitHubAuthResponse,
  GitHubRemoveAccountResponse,
  GitHubSetDefaultAccountResponse,
} from '@shared/github';
import { createRPCController } from '@shared/lib/ipc/rpc';

export const githubController = createRPCController({
  getAccountState: async (): Promise<GitHubAccountState> =>
    Result.tryAsync(async () => {
      // The accounts are the password vault's GitHub credentials (the first read moves the old ones in). A vault that
      // cannot be read, or a move that failed, is said on the connector with its repair — never an empty list.
      const accounts = await githubAccountService.listAccounts();
      return {
        connected: accounts.length > 0,
        accounts,
        defaultAccountId: accounts.find((account) => account.isDefault)?.accountId ?? null,
      };
    }).unwrapOrElse((error) => {
      log.error('Failed to get GitHub account state:', error);
      return { connected: false, accounts: [], defaultAccountId: null, error: vaultProblem(error) ?? error.message };
    }),

  auth: async (ownerConnection = false): Promise<GitHubAuthResponse> => {
    let result: Awaited<ReturnType<typeof githubDeviceFlowService.start>>;
    try {
      result = await githubDeviceFlowService.start();
    } catch (error) {
      log.error('GitHub authentication failed:', error);
      events.emit(githubAuthErrorChannel, {
        error: 'device_flow_error',
        message: 'Authentication failed',
      });
      return { success: false, error: 'Authentication failed' };
    }

    if (!result.success) return result;

    try {
      const accountSummary = (await githubAccountService.listAccounts()).find(
        (candidate) => candidate.accountId === result.account.id
      );
      if (!accountSummary) {
        const message = 'Failed to register GitHub account';
        events.emit(githubAuthErrorChannel, { error: 'account_registration_failed', message });
        return { success: false, error: message };
      }

      // Owner metadata must be committed before its dialog reports success.
      if (!ownerConnection) events.emit(githubAuthSuccessChannel, { user: result.user });
      return { success: true, account: accountSummary, ...(ownerConnection ? { user: result.user } : {}) };
    } catch (error) {
      log.error('Failed to register GitHub account after device flow:', error);
      const message = 'Failed to register GitHub account';
      events.emit(githubAuthErrorChannel, {
        error: 'account_registration_failed',
        message,
      });
      return { success: false, error: message };
    }
  },

  listAccounts: (): Promise<GitHubAccountSummary[]> =>
    Result.tryAsync(() => githubAccountService.listAccounts()).unwrapOrElse((error) => {
      log.error('Failed to list GitHub accounts:', error);
      return [];
    }),

  /** A token the person pasted (classic or fine-grained, or for a GitHub Enterprise host): checked with GitHub, then saved into the vault. */
  saveToken: (input: { host?: string; token: string }): Promise<GitHubAuthResponse> =>
    Result.tryAsync<GitHubAuthResponse>(async () => {
      const { saveGitHubToken } = await import('./github-paste-token');
      return { success: true, account: await saveGitHubToken(input.host ?? 'github.com', input.token) };
    }).unwrapOrElse((error) => {
      // `error` is the serialized throw (Result.tryAsync): its name, code and message, never the class.
      log.error('Failed to save a pasted GitHub token:', error.message);
      return { success: false, error: vaultProblem(error) ?? error.message };
    }),

  setDefaultAccount: (accountId: string): Promise<GitHubSetDefaultAccountResponse> =>
    Result.tryAsync<GitHubSetDefaultAccountResponse>(async () => {
      const account = await githubAccountService.setDefaultAccount(accountId);
      if (!account) return { success: false, error: 'GitHub account not found' };
      return { success: true, account };
    }).unwrapOrElse((error) => {
      log.error('Failed to set default GitHub account:', error);
      return { success: false, error: 'Failed to set default GitHub account' };
    }),

  removeAccount: (accountId: string): Promise<GitHubRemoveAccountResponse> =>
    Result.tryAsync<GitHubRemoveAccountResponse>(async () => {
      const accounts = await githubAccountService.removeAccount(accountId);
      if (!accounts) return { success: false, error: 'GitHub account not found' };
      return { success: true, accounts };
    }).unwrapOrElse((error) => {
      log.error('Failed to remove GitHub account:', error);
      return { success: false, error: 'Failed to remove GitHub account' };
    }),

  authCancel: (): Promise<{ success: true } | { success: false; error: string }> =>
    Result.tryAsync<{ success: true } | { success: false; error: string }>(async () => {
      githubDeviceFlowService.cancel();
      return { success: true };
    }).unwrapOrElse((error) => {
      log.error('Failed to cancel GitHub auth:', error);
      return { success: false, error: 'Failed to cancel' };
    }),

  // -- Repositories --------------------------------------------------------

  getOwners: (
    accountId?: string
  ): Promise<
    | { success: true; owners: Awaited<ReturnType<typeof repoService.getOwners>> }
    | { success: false; error: string }
  > =>
    Result.tryAsync<
      | { success: true; owners: Awaited<ReturnType<typeof repoService.getOwners>> }
      | { success: false; error: string }
    >(async () => {
      const owners = await repoService.getOwners({ accountId });
      return { success: true, owners };
    }).unwrapOrElse((error) => {
      log.error('Failed to get owners:', error);
      return { success: false, error: error.message ?? 'Failed to get owners' };
    }),

  createRepository: (params: {
    name: string;
    owner: string;
    description?: string;
    isPrivate?: boolean;
    visibility?: 'public' | 'private';
    accountId?: string | null;
  }): Promise<
    | {
        success: true;
        repoUrl: string;
        cloneUrl: string;
        nameWithOwner: string;
        defaultBranch: string;
      }
    | { success: false; error: string }
  > =>
    Result.tryAsync<
      | {
          success: true;
          repoUrl: string;
          cloneUrl: string;
          nameWithOwner: string;
          defaultBranch: string;
        }
      | { success: false; error: string }
    >(async () => {
      const isPrivate = params.isPrivate ?? params.visibility === 'private';
      const repoInfo = await repoService.createRepository({
        name: params.name,
        owner: params.owner,
        description: params.description,
        isPrivate,
        authContext: { accountId: params.accountId ?? undefined },
      });
      return {
        success: true,
        repoUrl: repoInfo.url,
        cloneUrl: repoInfo.cloneUrl,
        nameWithOwner: repoInfo.nameWithOwner,
        defaultBranch: repoInfo.defaultBranch,
      };
    }).unwrapOrElse((error) => {
      log.error('Failed to create repository:', error);
      return { success: false, error: error.message ?? 'Failed to create repository' };
    }),
});
