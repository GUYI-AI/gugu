import { useReplica } from '@/lib/replica';
import { integrationAccountChecks, integrationAccounts } from '@/components/connections/connection-replicas';
import { keepLibraryHost, useLibraryHost } from '@renderer/features/library/library-host';
import type { rpc } from '@renderer/lib/ipc';

export type IntegrationAccountSummary = Awaited<ReturnType<typeof rpc.integrations.accounts>>[number];
export type IntegrationAccountCheck = Awaited<ReturnType<typeof rpc.integrations.checkAccounts>>[number];

/**
 * #7240 一家集成存着的每个账号和连接状态。那台机器比这个功能老(`unknown_method`)⇒ `supported: false`,按单账号画;
 * 此刻问不到 ⇒ `reachable` false:不去问,上次读到的照画。
 */
export function useIntegrationAccounts(
  integrationId: string,
  configured: boolean,
  /** false = 只要账号清单(列表上的「N 个账号」):❌ 为数个数逐个登录对方服务。 */
  { check = true }: { check?: boolean } = {}
) {
  const host = keepLibraryHost(useLibraryHost());
  const reachable = host.assistantPanelExpected ? !!host.assistantPanel : host.remote?.online !== false;
  const accounts = useReplica(integrationAccounts, configured ? [host.key, integrationId] : null, { read: reachable });
  const listed = accounts.state === 'value' && accounts.value.supported ? accounts.value.accounts : null;
  const checks = useReplica(integrationAccountChecks, check && listed?.length ? [host.key, integrationId] : null, { read: reachable });
  return {
    accounts,
    checks,
    reachable,
    retry: () => {
      void integrationAccounts.refresh(host.key, integrationId);
      void integrationAccountChecks.refresh(host.key, integrationId);
    },
  };
}
