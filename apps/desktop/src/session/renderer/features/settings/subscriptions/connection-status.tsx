import { Unknown } from '@/components/ui/Unknown'
import type { AgentPayload } from '@shared/core/agents/agent-payload'
import { useAgentAuthStatus } from '@renderer/lib/stores/use-agent-auth-status'
import { useSessionMessages } from '@renderer/localization/use-session-messages'
import { resolveAccountTargets } from '../agents-page/agent-account'
import { refreshFailure } from '@/lib/replica'
import { useConnectionDetails, useListedConnections } from './listed-connections'
import { useSubscriptionPlan } from './subscription-queries'
import { payerLine } from './subscription-view'

/**
 * 一家的状态那一行:谁在付钱、套餐(订阅页那一行与资源库详情同一份读数、同一种写法 —— owner 2026-11-12
 * 「订阅和资源库的 Agent 其实是不统一的，但按理说应该统一才对」)。读的是**正在用的那个连接**:
 * 选中 API Key 连接时写那把 key,❌ 去读 CLI 自己的文件。
 */
export function useConnectionStatus(
  machine: string | null,
  agent: Pick<AgentPayload, 'id' | 'capabilities' | 'programs' | 'status'>
) {
  const { translate } = useSessionMessages()
  const { connections, form } = useListedConnections(machine, agent)
  const currentConnection = connections.state === 'value' ? connections.value.find((connection) => connection.current) : undefined
  // 有连接可管的家先等连接读回来:套餐按那个连接问,读的是那个连接的那一份读数(与菜单里那一行同一份)。
  const ready = form === null || !!currentConnection
  const details = useConnectionDetails(machine, agent.id, form !== null ? currentConnection?.id : undefined)
  const providerPlan = useSubscriptionPlan(machine, agent.id, form === null)
  const { auth } = useAgentAuthStatus(agent.id, undefined, { machine })
  const payer = form === null
    ? providerPlan.state === 'value' ? providerPlan.value : undefined
    : details.state === 'value' ? details.value.plan ?? undefined : undefined
  const failure = form === null
    ? providerPlan.state === 'error' ? providerPlan.error.message : null
    : details.state === 'value' ? details.value.planError ?? null : refreshFailure(details)?.message ?? null
  const description = payer
    ? payerLine(payer, translate, false)
    : failure !== null
      ? translate('subscriptions.unavailable.error', { message: failure })
      : null
  // null = 还说不出:它要用的那几份(有账号登录的家:登录态;有连接的家:连接;套餐)还没读到。
  // 一次写定,❌ 先写「查询中」、再写付费方、再换成账号。没有账号登录的家(Pi 这类)登录态永远是空的,不等它。
  const signsIn = resolveAccountTargets(agent).length > 0
  const identity: string | null =
    (signsIn && auth === null) || (form !== null && connections.state === 'unknown')
      ? null
      : auth?.status.kind === 'unauthenticated' && auth.status.reason === 'expired'
        ? translate('subscriptions.connections.expired')
        : form?.vendorKey && currentConnection?.kind === 'account'
          ? currentConnection.name || description
          : auth?.status.kind === 'authenticated' && auth.status.account
            ? auth.status.account
            : description
  const badge = payer?.plan ?? (payer?.payer === 'api-key' || payer?.payer === 'custom-endpoint' ? 'API' : undefined)
  return { identity, badge, ready, currentConnection, connections }
}

export function ConnectionStatusLine({
  agentId,
  identity,
  badge
}: {
  agentId: string
  identity: string | null
  badge: string | undefined
}) {
  return (
    <span className="subscription-status-line" data-testid={`connection-status-${agentId}`}>
      <span>{identity ?? <Unknown className="w-32" />}</span>
      {badge && <span className="subscription-plan-badge">{badge}</span>}
    </span>
  )
}
