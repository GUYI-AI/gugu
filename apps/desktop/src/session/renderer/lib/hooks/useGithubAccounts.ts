import { retryAssistantPanelRead } from '@gugu/core/cloud/assistantPanelRead';
import { useMutation } from '@tanstack/react-query';
import { queryClient, replica, useReplica, type Reading } from '@/lib/replica';
import { keepLibraryHost, libraryHostOf, peekLibraryHost, useLibraryHost, type LibraryHost } from '@renderer/features/library/library-host';
import { CONNECTIONS } from '@/components/connections/connection-replicas';
import { refreshTag } from '@/lib/replica';
import type { GitHubAccountSummary } from '@shared/github';

/**
 * GitHub 账号是**这台机器上**连的(#6264 整个资源库都分机器);按机器(`host.key`)各一条。Signal tier.
 */
export const githubAccounts = replica({
  name: 'githubAccounts',
  scope: 'device',
  read: (_owner, hostKey: string): Promise<GitHubAccountSummary[]> => libraryHostOf(hostKey).github.listAccounts(),
  // An assistant panel's store may still be settling right after it opened: its read is retried (another host's is not).
  retry: (failures, error, hostKey) => !!peekLibraryHost(hostKey)?.assistantPanelExpected && retryAssistantPanelRead(failures, error),
  fresh: 30_000,
  refreshOnFocus: true,
});

/** Whether this host can be asked now: its store is there (assistant panel, connection metadata), its machine online. */
function askable(host: LibraryHost): boolean {
  if (host.connectionMetadataExpected) return !!host.connectionMetadata;
  if (host.assistantPanelExpected) return !!host.assistantPanel;
  return host.remote?.online !== false;
}

/**
 * Every host's list is read again, and the connection readings derived from them.
 */
export function refreshGitHubAccountState(): void {
  void githubAccounts.refresh();
  void refreshTag(CONNECTIONS);
}

export function useGitHubAccounts(): Reading<GitHubAccountSummary[]> {
  const host = keepLibraryHost(useLibraryHost());
  return useReplica(githubAccounts, askable(host) ? [host.key] : null);
}

export function useImportGitHubCliAccounts() {
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async () => {
      return host.github.importCliAccounts();
    },
    onSuccess: refreshGitHubAccountState,
  }, queryClient);
}

export function useGitHubDeviceFlowAuth() {
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async () => {
      return host.github.auth();
    },
    onSettled: refreshGitHubAccountState,
  }, queryClient);
}

export function useSetDefaultGitHubAccount() {
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async (accountId: string) => {
      return host.github.setDefaultAccount(accountId);
    },
    onSuccess: refreshGitHubAccountState,
  }, queryClient);
}

export function useRemoveGitHubAccount() {
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async (accountId: string) => {
      return host.github.removeAccount(accountId);
    },
    onSuccess: refreshGitHubAccountState,
  }, queryClient);
}
