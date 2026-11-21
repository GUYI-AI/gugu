import { useConnectionReadNotice } from '@/components/connections/useConnectionReadNotice';
import { ownerConnectionMetadataView } from '@/components/connections/owner-connection-metadata';
import { builtinConnectionCatalog } from '@/components/connections/builtin-connection-catalog';
import type { ConnectionMetadataSnapshot } from '@/components/connections/connection-metadata';
import { chatChannels, configuredConnections, CONNECTIONS_ON_HOST, integrationsCatalog, integrationStatuses, useOwnerConnectionsReading } from '@/components/connections/connection-replicas';
import { EMPTY_INTEGRATION_SUMMARIES,useAssistantIntegrationSummaries } from '@/components/assistant/useAssistantIntegrationSummaries';
import { connectionList, registerConnectionStore, useConnectionList } from '@/components/assistant/assistant-panel-reads';
import { isAssistantPanelReadRetryable } from '@gugu/core/cloud/assistantPanelRead';
import { refreshFailure, refreshTag, useReplica, type Reading } from '@/lib/replica';
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { keepLibraryHost, useLibraryHost } from '@renderer/features/library/library-host';
import { registerIssueMentionIcons } from '@renderer/lib/chat/chat-mention-provider';
import { rpcOn, type rpc } from '@renderer/lib/ipc';
import { reportAssistantAppChange } from '@/components/assistant/assistant-app-client';
import { cachedDevicesAccount } from '@/store/devicesCache';
import type { ConnectionStatus } from '@shared/issue-providers';
import {
  getSessionLocaleSnapshot,
  subscribeSessionLocale,
  translateSessionMessage,
} from '@renderer/localization/locale-store';
import { integrationErrorText } from './integration-display';
import { prepareThenStartCliLogin } from './cli-tool-prepare';
import type { IntegrationFormInput } from './types';
import { supportedCliIntegrations } from '@shared/integration-cli-platform';

export type IntegrationMetadata = Awaited<ReturnType<typeof rpc.integrations.list>>[number] & { metadataOnly?: true; summaryNameMissing?: boolean; catalogVersion?: string };
export type CliLoginStartResult = Awaited<ReturnType<typeof rpc.integrations.cliLoginStart>>;
export type CliLoginWaitResult = Awaited<ReturnType<typeof rpc.integrations.cliLoginWait>>;

type ConnectionStatusByIntegration = Partial<Record<string, ConnectionStatus>>;

type ConnectionMutationResult = { success: true } | { success: false; error: string };
type RawConnectionMutationResult = { success: boolean; error?: string; errorType?: ConnectionStatus['errorType'] };

type IntegrationsContextValue = {
  integrations: IntegrationMetadata[] | null;
  connectionOperations: ConnectionMetadataSnapshot['application'] | null;
  integrationById: Partial<Record<string, IntegrationMetadata>>;
  connectionStatus: ConnectionStatusByIntegration | null;
  connectionCheckError: unknown;
  configuredConnectionsError: unknown;
  configuredConnections: Partial<Record<string, boolean>> | null;
  isCheckingConfiguredConnections: boolean;
  isCheckingConnections: boolean;
  reloadConnections: () => void;
  connectIntegration: (
    integrationId: string,
    input: IntegrationFormInput,
    /** #7240「编辑凭据」:改哪个已存账号(留空的授权码沿用存着的)。 */
    editAccountId?: string
  ) => Promise<ConnectionMutationResult>;
  /** `accountId`(#7240):多账号里只断开这一个;不给 = 整家断开。 */
  disconnectIntegration: (integrationId: string, accountId?: string) => Promise<ConnectionMutationResult>;
  /** Browser authorization (`mcp-oauth`); settles when the user approves, denies or cancels. */
  authorizeIntegration: (integrationId: string) => Promise<ConnectionMutationResult>;
  cancelIntegrationAuthorization: (integrationId: string) => void;
  /** #7210 官方命令行:装工具、起它自带的登录,回给人看的授权链接 / 二维码。 */
  startCliLogin: (integrationId: string) => Promise<CliLoginStartResult>;
  /** 等那次登录落定;每问最多二十来秒,`pending` 就再问。落定后刷新连接状态。 */
  waitCliLogin: (integrationId: string) => Promise<CliLoginWaitResult>;
  readCliProgress?: (integrationId: string) => ReturnType<typeof rpc.integrations.cliLoginProgress>;
  isIntegrationMutating: (integrationId: string) => boolean;
  /** 读清单的错误与有没有读到(资源库看别的机器时,页面据此说那台机器怎么了)。 */
  listError: unknown;
  hasList: boolean;
  reloadList: () => void;
};

const IntegrationsContext = createContext<IntegrationsContextValue | null>(null);

/**
 * 集成是**这台机器上**连的(凭据存在这台机器的库里,#6264 整个资源库都分机器)。应用根上那一份问本机
 * (聊天里的 @issue 用它);资源库选了别的机器时,资源库里另挂一份,问的是那台机器(`useLibraryHost`)。
 * 缓存键带机器,两份互不覆盖。
 */
export function IntegrationsProvider({ children }: { children: React.ReactNode }) {
  const host = keepLibraryHost(useLibraryHost());
  const api = host.integrations;
  const metadata = host.connectionMetadata ?? host.assistantPanel;
  const metadataExpected = host.connectionMetadataExpected ?? host.assistantPanelExpected;
  const ownerMode = !!host.connectionMetadataExpected;
  useEffect(() => chatChannels.hold(), []);
  const remote = !!host.remote;
  const [mutatingIntegrationIds, setMutatingIntegrationIds] = useState<Set<string>>(
    () => new Set()
  );

  // 那台机器离线就不问(问不到,只会挂满超时)。
  const enabled = metadataExpected ? !!metadata || !!host.connectionMetadataError || !!host.assistantPanelError : host.remote?.online !== false;
  // 插件的中英两份由那台机器的主进程按这台桌面的界面语言解析成字符串;换语言重取。
  const locale = useSyncExternalStore(subscribeSessionLocale, () => getSessionLocaleSnapshot().resolvedLocale);
  // Owner mode: one snapshot (the owner's connections) is the whole answer.
  const ownerReading = useOwnerConnectionsReading(ownerMode ? host.connectionMetadata : undefined);
  useConnectionReadNotice(`snapshot:${host.key}`, ownerReading.state === 'value', ownerMode && ownerReading.state === 'error' ? Infinity : 0);
  const ownerView = useMemo(() => ownerReading.state === 'value' ? ownerConnectionMetadataView(ownerReading.value, locale) : null, [ownerReading, locale]);
  // An assistant's panel: its list is the one `connectionList` reading (the App counts read the same entry), ❌ three
  // host readings of the same rows. A panel that failed to load is that failure.
  const panelHost = !ownerMode && !!host.assistantPanelExpected;
  const panelKey = panelHost && metadata ? registerConnectionStore(metadata) : null;
  const panelList = useConnectionList(panelHost ? metadata : undefined, false, locale, enabled);
  const panelReading: typeof panelList = panelHost && !metadata && host.assistantPanelError
    ? { state: 'error', error: host.assistantPanelError as Error } : panelList;
  const hostKey = ownerMode || panelHost ? null : host.key;
  const catalogReading = useReplica(integrationsCatalog, hostKey ? [hostKey, locale] : null, { read: enabled });
  const hostStatusReading = useReplica(integrationStatuses, hostKey ? [hostKey] : null, { read: enabled });
  const hostConfiguredReading = useReplica(configuredConnections, hostKey ? [hostKey] : null, { read: enabled });
  const listReading = panelHost ? partOf(panelReading, 'items') : catalogReading;
  const statusReading = panelHost ? partOf(panelReading, 'statuses') : hostStatusReading;
  const configuredReading = panelHost ? partOf(panelReading, 'configured') : hostConfiguredReading;

  const listData: IntegrationMetadata[] | null = ownerMode ? ownerView?.items ?? builtinConnectionCatalog(locale)
    : listReading.state === 'value' ? listReading.value : null;
  const summaries = useAssistantIntegrationSummaries(metadata, listData ?? EMPTY_INTEGRATION_SUMMARIES, locale);
  // Includes cached/generated metadata and the first render. A saved row or
  // an older host publication must not restore an unsupported setup entry.
  const integrations = useMemo(() => listData === null ? null : supportedCliIntegrations(summaries, host.executionHost), [listData, summaries, host.executionHost]);

  useEffect(() => {
    // @issue 的图标是聊天里用的,聊天只跟本机那一份走。
    if (!remote && integrations) registerIssueMentionIcons(integrations);
  }, [integrations, remote]);

  const statusData = ownerMode ? ownerView?.statuses ?? null : statusReading.state === 'value' ? statusReading.value : null;
  const configuredData = ownerMode ? ownerView?.configured ?? null : configuredReading.state === 'value' ? configuredReading.value : null;
  const connectionReadError = refreshFailure(ownerMode ? ownerReading : statusReading);
  const configuredConnectionsError = refreshFailure(ownerMode ? ownerReading : configuredReading);
  const listError = ownerMode ? null : refreshFailure(listReading);

  const invalidateStatuses = useCallback(() => {
    // A completed authorization invalidates both the file snapshot and all visible consumers.
    // The host's subsequent publication uses the same event when authorization finishes elsewhere.
    metadata?.invalidate();
    if (panelKey) void connectionList.refresh(panelKey);
    void refreshTag(CONNECTIONS_ON_HOST, host.key);
  }, [host.key, metadata, panelKey]);

  const setIntegrationMutating = useCallback((integrationId: string, isMutating: boolean) => {
    setMutatingIntegrationIds((current) => {
      if (current.has(integrationId) === isMutating) return current;

      const next = new Set(current);
      if (isMutating) {
        next.add(integrationId);
      } else {
        next.delete(integrationId);
      }
      return next;
    });
  }, []);

  const runConnectionMutation = useCallback(
    async (
      integrationId: string,
      mutation: () => Promise<RawConnectionMutationResult>,
      fallbackError: string,
      change: { operation: 'saved' | 'removed'; id?: string } = { operation: 'saved' },
    ): Promise<ConnectionMutationResult> => {
      const ownerId = cachedDevicesAccount();
      setIntegrationMutating(integrationId, true);
      try {
        const result = await mutation();
        if (!result.success) {
          const name = integrations?.find((integration) => integration.id === integrationId)?.name ?? integrationId;
          return { success: false, error: integrationErrorText(translateSessionMessage, name, result) || fallbackError };
        }
        if (!host.connectionMetadataExpected && (!host.assistantPanelExpected || change.operation !== 'removed')) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined, {
          resource: 'integrations', operation: change.operation, id: change.id ?? integrationId, deviceId: host.remote?.deviceId,
          ...(change.operation === 'removed' ? {} : { after: { name: integrations?.find(integration => integration.id === integrationId)?.name ?? integrationId } }),
        }, ownerId);
        return { success: true };
      } finally {
        setIntegrationMutating(integrationId, false);
        invalidateStatuses();
      }
    },
    [integrations, invalidateStatuses, setIntegrationMutating, host.remote?.deviceId,host.assistantPanelExpected,host.connectionMetadataExpected]
  );

  const connectIntegration = useCallback(
    async (integrationId: string, input: IntegrationFormInput, editAccountId?: string) =>
      runConnectionMutation(
        integrationId,
        () => api.connect(integrationId, input, editAccountId),
        'Failed to connect.'
      ),
    [runConnectionMutation, api]
  );

  const disconnectIntegration = useCallback(
    async (integrationId: string, accountId?: string) =>
      runConnectionMutation(
        integrationId,
        () => api.disconnect(integrationId, accountId),
        'Failed to disconnect.',
        { operation: 'removed', id: accountId ? `${integrationId}:${accountId}` : integrationId },
      ),
    [runConnectionMutation, api]
  );

  const authorizeIntegration = useCallback(
    async (integrationId: string) =>
      runConnectionMutation(
        integrationId,
        () => api.authorize(integrationId),
        'Failed to authorize.'
      ),
    [runConnectionMutation, api]
  );

  // 每次起命令行连接领一个号;取消就作废,还在等工具装好的那一圈不再起登录。
  const cliGenerations = useRef(new Map<string, number>());
  const cancelIntegrationAuthorization = useCallback(
    (integrationId: string) => {
      cliGenerations.current.set(integrationId, (cliGenerations.current.get(integrationId) ?? 0) + 1);
      void api.cancelAuthorization(integrationId);
    },
    [api]
  );

  const startCliLogin = useCallback(
    async (integrationId: string) => {
      const ownerId = cachedDevicesAccount();
      setIntegrationMutating(integrationId, true);
      try {
        const generation = (cliGenerations.current.get(integrationId) ?? 0) + 1;
        cliGenerations.current.set(integrationId, generation);
        const result = await prepareThenStartCliLogin(api, integrationId, {
          cancelled: () => cliGenerations.current.get(integrationId) !== generation,
          timeoutError: () => new Error(translateSessionMessage('integrations.cliPrepareTimedOut')),
        });
        if (!result) return { success: false as const, error: 'This connection attempt was cancelled.', cancelled: true as const };
        if (result.success && 'connected' in result) {
          invalidateStatuses();
          if (!host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
            { resource: 'integrations', operation: 'saved', id: integrationId, deviceId: host.remote?.deviceId }, ownerId);
        }
        return result;
      } finally {
        setIntegrationMutating(integrationId, false);
      }
    },
    [api, invalidateStatuses, setIntegrationMutating, host.remote?.deviceId,host.connectionMetadataExpected]
  );

  const waitCliLogin = useCallback(
    async (integrationId: string) => {
      const ownerId = cachedDevicesAccount();
      const result = await api.cliLoginWait(integrationId);
      if (result.status !== 'pending') invalidateStatuses();
      if (result.status === 'connected' && !host.connectionMetadataExpected) await reportAssistantAppChange({ rpc: rpcOn(host.remote?.deviceId ?? null) }, undefined,
        { resource: 'integrations', operation: 'saved', id: integrationId, deviceId: host.remote?.deviceId }, ownerId);
      return result;
    },
    [api, invalidateStatuses, host.remote?.deviceId,host.connectionMetadataExpected]
  );

  const readCliProgress = useCallback((integrationId: string) => api.cliLoginProgress(integrationId), [api]);

  const isIntegrationMutating = useCallback(
    (integrationId: string) => mutatingIntegrationIds.has(integrationId),
    [mutatingIntegrationIds]
  );

  const integrationById = useMemo(
    () =>
      Object.fromEntries(
        (integrations ?? []).map((integration: IntegrationMetadata) => [integration.id, integration])
      ),
    [integrations]
  );

  return (
    <IntegrationsContext.Provider
      value={{
        integrations,
        connectionOperations: ownerReading.state === 'value' ? ownerReading.value.application : null,
        integrationById,
        connectionStatus: statusData,
        connectionCheckError: metadataExpected && statusData !== null && isAssistantPanelReadRetryable(connectionReadError) ? null : connectionReadError,
        configuredConnectionsError: metadataExpected && configuredData !== null && isAssistantPanelReadRetryable(configuredConnectionsError) ? null : configuredConnectionsError,
        configuredConnections: configuredData,
        // Checking = a read on its way or due: ❌ for a host not asked now (offline), whose answer never comes.
        isCheckingConfiguredConnections: configuredData === null && !configuredConnectionsError && (ownerMode || enabled),
        isCheckingConnections: statusData === null && !connectionReadError && (ownerMode || enabled),
        reloadConnections: invalidateStatuses,
        connectIntegration,
        disconnectIntegration,
        authorizeIntegration,
        cancelIntegrationAuthorization,
        startCliLogin,
        waitCliLogin,
        readCliProgress,
        isIntegrationMutating,
        listError,
        hasList: listData !== null,
        reloadList: () => { void (panelKey ? connectionList.refresh(panelKey) : integrationsCatalog.refresh(host.key)); },
      }}
    >
      {children}
    </IntegrationsContext.Provider>
  );
}

/** One part of a reading's value; its state (stale, failure, retry) as it is. */
function partOf<V, K extends keyof V>(reading: Reading<V>, part: K): Reading<V[K]> {
  return reading.state === 'value' ? { ...reading, value: reading.value[part] } : reading;
}

export function useIntegrationsContext() {
  const ctx = useContext(IntegrationsContext);
  if (!ctx) throw new Error('useIntegrationsContext must be used inside IntegrationsProvider');
  return ctx;
}
