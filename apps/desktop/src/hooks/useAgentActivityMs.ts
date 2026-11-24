import { useCallback } from 'react'
import { activityMs } from '@gugu/core/shared/ui/chatModels'
import { useAgentRecentActivity } from './useAgentDisplayStatus'

/**
 * Where each agent stands in the agent order (compareByRecentActivity): its session's last interaction (presence
 * lastInteractedAt), else when it was made (its identity's created_at). Lists sort by it; pickers fall back to it
 * (rankMentionCandidates).
 */
export function useAgentActivityMs(
  agentUserIds: readonly string[],
  identitiesById: Readonly<Record<string, { created_at?: string | null } | undefined>>,
): (id: string) => number {
  const activity = useAgentRecentActivity(agentUserIds)
  return useCallback((id: string) => activityMs(activity[id]?.lastInteractedAt, identitiesById[id]?.created_at), [activity, identitiesById])
}
