import { useReplica } from '@/lib/replica';
import { integrationAccountChecks, integrationAccounts } from '@/components/connections/connection-replicas';
import { keepLibraryHost, useLibraryHost } from '@renderer/features/library/library-host';
import type { rpc } from '@renderer/lib/ipc';

export type IntegrationAccountSummary = Awaited<ReturnType<typeof rpc.integrations.accounts>>[number];
export type IntegrationAccountCheck = Awaited<ReturnType<typeof rpc.integrations.checkAccounts>>[number];

/**
 * #7240 一家集成存着的每个账号,和逐个查出来的连接状态(资源库详情的「%s 连接」):`integrationAccounts` /
 * `integrationAccountChecks` 两个 replica(connection-replicas.ts)的读数,连上 / 断开 / 重新授权之后随连接状态一起重读。
 * 那台机器比这个功能老(`unknown_method`)⇒ `supported: false`,详情照旧按单账号画。没连这一家:没有账号可读(unknown)。
 * 那台机器此刻问不到(离线、它的面板还没来)`reachable` 为 false:不去问,上次读到的照画。
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
