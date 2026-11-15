import { useReplica } from '@/lib/replica';
import { integrationAccountChecks, integrationAccounts } from '@/components/connections/connection-replicas';
import { keepLibraryHost, useLibraryHost } from '@renderer/features/library/library-host';
import type { rpc } from '@renderer/lib/ipc';

export type IntegrationAccountSummary = Awaited<ReturnType<typeof rpc.integrations.accounts>>[number];
export type IntegrationAccountCheck = Awaited<ReturnType<typeof rpc.integrations.checkAccounts>>[number];

/**
 * #7240 一家集成存着的每个账号,和逐个查出来的连接状态(资源库详情的「%s 连接」):`integrationAccounts` /
 * `integrationAccountChecks` 两个 replica(connection-replicas.ts),连上 / 断开 / 重新授权之后随连接状态一起重读。
 * 那台机器比这个功能老(`unknown_method`)⇒ `supported: false`,详情照旧按单账号画。
 * `accounts` / `supported` 是 null = 还没读到(❌ 画成「没有账号」)。
 */
export function useIntegrationAccounts(
  integrationId: string,
  configured: boolean,
  /** false = 只要账号清单(列表上的「N 个账号」):❌ 为数个数逐个登录对方服务。 */
  { check = true }: { check?: boolean } = {}
) {
  const host = keepLibraryHost(useLibraryHost());
  const enabled = configured && (host.assistantPanelExpected ? !!host.assistantPanel : host.remote?.online !== false);
  const reading = useReplica(integrationAccounts, enabled ? [host.key, integrationId] : null);
  const value = reading.state === 'value' ? reading.value : null;
  const listed = value?.supported ? value.accounts : null;
  const checks = useReplica(integrationAccountChecks, check && listed && listed.length > 0 ? [host.key, integrationId] : null);
  return {
    supported: value ? value.supported : null,
    accounts: value ? (value.supported ? value.accounts : []) : null,
    error: reading.state === 'error' ? reading.error : null,
    retry: () => void integrationAccounts.refresh(host.key, integrationId),
    checks: checks.state === 'value' ? new Map(checks.value.map((one) => [one.accountId, one])) : null,
    isChecking: checks.state === 'unknown' && !!listed?.length && check,
  };
}
