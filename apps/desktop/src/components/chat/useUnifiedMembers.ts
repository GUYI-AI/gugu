import { useMemo } from 'react'
import type { GroupCollabSnapshot } from '@gugu/core/shared/types/chat'
import { useAgentActivityMs } from '../../hooks/useAgentActivityMs'
import { useChatStoreSelect } from '../../store/chatContext'
import { buildUnifiedMembers, type UnifiedMember } from './groupMemberModels'

/** A group's or topic's members in the one member order (buildUnifiedMembers), its agents read in the agent order. */
export function useUnifiedMembers(snapshot: GroupCollabSnapshot | null | undefined): UnifiedMember[] {
  const identitiesById = useChatStoreSelect((store) => store.identitiesById)
  const agentIds = useMemo(() => snapshot?.agents.map((agent) => agent.id) ?? [], [snapshot])
  const activityMs = useAgentActivityMs(agentIds, identitiesById)
  return useMemo(() => snapshot ? buildUnifiedMembers(snapshot, activityMs) : [], [snapshot, activityMs])
}
