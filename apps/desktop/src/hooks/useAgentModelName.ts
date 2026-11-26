import { useCallback, useSyncExternalStore } from 'react'
import { getAgentPresenceSnapshot, subscribeAgentPresence } from '../lib/agentPresenceStore'

/**
 * The model this agent runs on, as its host's model list names it (presence `model_name`): one string, so a presence
 * tick that changes something else does not re-render the reader. null = not known (no presence yet, removed, the
 * host does not report it) — the reader leaves its cell out.
 */
export function useAgentModelName(agentId: string | undefined): string | null {
  const subscribe = useCallback((notify: () => void) => agentId
    ? subscribeAgentPresence(agentId, notify)
    : () => {}, [agentId])
  const snapshot = useCallback(() => {
    const payload = agentId ? getAgentPresenceSnapshot(agentId)?.payload : null
    return payload && payload.accountStatus !== 'removed' ? payload.modelName : null
  }, [agentId])
  return useSyncExternalStore(subscribe, snapshot, snapshot)
}
