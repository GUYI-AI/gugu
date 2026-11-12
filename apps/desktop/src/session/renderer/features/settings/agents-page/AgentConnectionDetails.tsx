import type { AgentPayload } from '@shared/core/agents/agent-payload'
import { SubscriptionConnections } from '../subscriptions/SubscriptionConnections'
import { ConnectionStatusLine, useConnectionStatus } from '../subscriptions/connection-status'

/**
 * 一家的「连接」那一块:状态那一行、当前连接、添加连接。资源库详情与设置「订阅」页那一行渲染的都是它
 * (owner 2026-11-12:「统一成『添加连接』和『当前连接』，在这儿都能管」)—— ❌ 两处各写一套判断。
 * `embedded`:嵌在订阅页那一行里,不另起「连接」组头。
 */
export function AgentConnectionDetails({
  agent,
  machine,
  embedded = false
}: {
  agent: AgentPayload
  machine: string | null
  embedded?: boolean
}) {
  const { identity, badge } = useConnectionStatus(machine, agent)
  return (
    <SubscriptionConnections
      agent={agent}
      machine={machine}
      settingsRows
      embedded={embedded}
      description={<ConnectionStatusLine agentId={agent.id} identity={identity} badge={badge} />}
    />
  )
}
