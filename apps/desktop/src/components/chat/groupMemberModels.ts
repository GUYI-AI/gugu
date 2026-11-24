// @@@2178 — 群成员模型助手,从冻结的 GroupMembersSection.tsx 抽出,供该组件与 GroupMemberAvatarRow 共用
// (抽出同时抵消 god 文件增行)。纯数据/排序,无 React。
import type {
  GroupAgentItem,
  GroupCollabSnapshot,
  GroupMemberItem,
  GroupMemberRole,
} from '@gugu/core/shared/types/chat'
import { compareByRecentActivity } from '@gugu/core/shared/ui/chatModels'

export interface UnifiedMember {
  id: string
  type: 'human' | 'agent'
  raw: GroupMemberItem | GroupAgentItem
  role: GroupMemberRole
}

// @@@unified-member-sort - owner first, then admin, then member; humans before agents within role; agents within that
// in the agent order (compareByRecentActivity over `agentActivityMs`, useAgentActivityMs), people by id.
function sortRoleWeight(role: GroupMemberRole): number {
  if (role === 'owner') return 0
  if (role === 'admin') return 1
  return 2
}

/** How many members a group shows by face: its grid avatar and its share poster. */
export const GROUP_FACES = 9

export function buildUnifiedMembers(snapshot: GroupCollabSnapshot, agentActivityMs: (id: string) => number): UnifiedMember[] {
  const all: UnifiedMember[] = [
    ...snapshot.humans.map((h) => ({ id: h.id, type: 'human' as const, raw: h, role: h.role })),
    ...snapshot.agents.map((a) => ({ id: a.id, type: 'agent' as const, raw: a, role: a.role })),
  ]
  all.sort((a, b) => {
    const dr = sortRoleWeight(a.role) - sortRoleWeight(b.role)
    if (dr !== 0) return dr
    if (a.type !== b.type) return a.type === 'human' ? -1 : 1
    if (a.type === 'agent') return compareByRecentActivity({ id: a.id, activityMs: agentActivityMs(a.id) }, { id: b.id, activityMs: agentActivityMs(b.id) })
    return a.id.localeCompare(b.id)
  })
  return all
}
