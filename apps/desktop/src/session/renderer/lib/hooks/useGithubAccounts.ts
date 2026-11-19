import { isAssistantPanelReadRetryable } from '@gugu/core/cloud/assistantPanelRead';
import { useMutation } from '@tanstack/react-query';
import { queryClient, replica, useReplica, type Reading } from '@/lib/replica';
import { keepLibraryHost, libraryHostOf, useLibraryHost, type LibraryHost } from '@renderer/features/library/library-host';
import { rpcOn } from '@renderer/lib/ipc';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { cachedDevicesAccount } from '@/store/devicesCache';
import { CONNECTIONS } from '@/components/connections/connection-replicas';
import { refreshTag } from '@/lib/replica';
import type { GitHubAccountSummary } from '@shared/github';

/** An assistant panel's store may still be settling right after it opened. */
const ASSISTANT_PANEL_READ_ATTEMPTS = 3;

/**
 * GitHub 账号是**这台机器上**连的(#6264 整个资源库都分机器);按机器(`host.key`)各一条。Signal tier.
 */
export const githubAccounts = replica({
  name: 'githubAccounts',
  scope: 'device',
  read: async (_owner, hostKey: string): Promise<GitHubAccountSummary[]> => {
    const host = libraryHostOf(hostKey);
    for (let attempt = 1; ; attempt++) {
      try {
        return await host.github.listAccounts();
      } catch (error) {
        if (!host.assistantPanelExpected || attempt >= ASSISTANT_PANEL_READ_ATTEMPTS || !isAssistantPanelReadRetryable(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
      }
    }
  },
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
      const ownerId = cachedDevicesAccount();
      const result = await host.github.importCliAccounts();
      if (result.success && result.importedAccountIds.length && !host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'saved', section: 'accounts', id: 'github', deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    onSuccess: refreshGitHubAccountState,
  }, queryClient);
}

export function useGitHubDeviceFlowAuth() {
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async () => {
      const ownerId = cachedDevicesAccount();
      const result = await host.github.auth();
      if (result.success && !host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'saved', section: 'accounts', id: 'github', deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    onSettled: refreshGitHubAccountState,
  }, queryClient);
}

export function useSetDefaultGitHubAccount() {
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async (accountId: string) => {
      const ownerId = cachedDevicesAccount();
      const result = await host.github.setDefaultAccount(accountId);
      if (result.success && !host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'edited', section: 'accounts', id: `github:${accountId}`, deviceId: host.remote?.deviceId,
          after: { isDefault: true } }, ownerId);
      return result;
    },
    onSuccess: refreshGitHubAccountState,
  }, queryClient);
}

export function useRemoveGitHubAccount() {
  const host = useLibraryHost();
  return useMutation({
    mutationFn: async (accountId: string) => {
      const ownerId = cachedDevicesAccount();
      const result = await host.github.removeAccount(accountId);
      if (result.success && !host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'removed', section: 'accounts', id: `github:${accountId}`, deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    onSuccess: refreshGitHubAccountState,
  }, queryClient);
}
