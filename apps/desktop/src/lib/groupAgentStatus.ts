import type { AgentDisplayStatus } from '@gugu/core/shared/types/chat'

export type GroupAgentStatusMember = string | {
  id: string
  account_status?: string | null
}

// 一格里只能放一个 agent 时,放最需要人看的那个:需要你 > 出错 > 在跑 > 后台在跑 > 启动中 > 在线 > 确认中 > 不在线 > 已移除。
// 与会话页侧栏、手机的「最需要你」同一个次序(core agentStatusUrgency:needs_user > error > working > idle)。
const GROUP_AGENT_STATUS_RANK: Record<AgentDisplayStatus, number> = {
  removed: 0,
  offline: 1,
  archived: 1,
  pending: 2,
  idle: 3,
  starting: 4,
  parked: 5,
  working: 6,
  error: 7,
  needs_user: 8,
}

export function groupAgentStatusRank(status: AgentDisplayStatus): number {
  return GROUP_AGENT_STATUS_RANK[status]
}

export function groupAgentDisplayStatus(
  member: GroupAgentStatusMember,
  statuses: Readonly<Record<string, AgentDisplayStatus>>,
): AgentDisplayStatus {
  if (typeof member !== 'string' && member.account_status === 'removed') return 'removed'
  const id = typeof member === 'string' ? member : member.id
  return statuses[id] ?? 'pending'
}
