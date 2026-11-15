import { isAssistantPanelReadRetryable } from '@gugu/core/cloud/assistantPanelRead';
import { useMutation } from '@tanstack/react-query';
import { queryClient, replica, useReplica, type Reading } from '@/lib/replica';
import { useLibraryHost, type LibraryGithubRpc, type LibraryHost } from '@renderer/features/library/library-host';
import { rpcOn } from '@renderer/lib/ipc';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { cachedDevicesAccount } from '@/store/devicesCache';
import type { GitHubAccountSummary } from '@shared/github';

/**
 * Which machine's (or assistant panel's) GitHub API a key names. A library host is an object of functions, so the
 * replica is keyed by `host.key` and the host showing it registers its API under that key before reading.
 */
const githubApis = new Map<string, { api: LibraryGithubRpc; assistantPanel: boolean }>();

/** An assistant panel's store may still be settling right after it opened: such a failure is asked again twice. */
const ASSISTANT_PANEL_READ_ATTEMPTS = 3;

/**
 * GitHub 账号是**这台机器上**连的(#6264 整个资源库都分机器):资源库选了别的机器时,列 / 连 / 设默认 / 移除
 * 都是那台机器上的;其余地方(项目设置、PR 选择器)用本机的。按机器(`host.key`)各一条,两份互不覆盖。
 * Signal tier: the machine says when its accounts change (`githubAccountsChangedChannel`, github-context-provider),
 * writes here refresh it, and it is read again when the window returns.
 */
export const githubAccounts = replica({
  name: 'githubAccounts',
  scope: 'device',
  read: async (_owner, hostKey: string): Promise<GitHubAccountSummary[]> => {
    const host = githubApis.get(hostKey);
    if (!host) throw new Error(`No GitHub API registered for ${hostKey}`);
    for (let attempt = 1; ; attempt++) {
      try {
        return await host.api.listAccounts();
      } catch (error) {
        if (!host.assistantPanel || attempt >= ASSISTANT_PANEL_READ_ATTEMPTS || !isAssistantPanelReadRetryable(error)) throw error;
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

type GitHubStateListener = () => void;
const stateListeners = new Set<GitHubStateListener>();

/**
 * Something changed the GitHub accounts (connected, imported, defaulted, removed, or the machine said so): every host's
 * list is read again, and whoever derives from them (the integrations' connection status) hears it.
 */
export function refreshGitHubAccountState(): void {
  void githubAccounts.refresh();
  stateListeners.forEach((listener) => listener());
}

/** Hear `refreshGitHubAccountState`; returns the unsubscribe. */
export function onGitHubAccountStateChanged(listener: GitHubStateListener): () => void {
  stateListeners.add(listener);
  return () => { stateListeners.delete(listener); };
}

/** The GitHub accounts of the library's machine. */
export function useGitHubAccounts(): Reading<GitHubAccountSummary[]> {
  const host = useLibraryHost();
  githubApis.set(host.key, { api: host.github, assistantPanel: !!host.assistantPanelExpected });
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
