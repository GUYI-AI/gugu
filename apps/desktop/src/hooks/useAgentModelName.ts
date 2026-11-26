import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { getAgentPresenceSnapshot, subscribeAgentPresence } from '../lib/agentPresenceStore'
import { useSelect, type Readable } from '../lib/selectStore'

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

/**
 * The models of several agents, keyed by agent id, for a list that renders a row per agent and cannot call a hook per
 * row. An agent whose model is not known is absent — its row leaves the cell out.
 */
export function useAgentModelNames(agentUserIds: readonly string[]): Readonly<Record<string, string>> {
  // Keyed by the id values, not the array: a caller's fresh array of the same ids keeps the subscription.
  const idsKey = useMemo(() => Array.from(new Set(agentUserIds.filter(Boolean))).sort().join(','), [agentUserIds])
  const presences = useMemo<Readable<readonly string[]>>(() => {
    const ids = idsKey ? idsKey.split(',') : []
    return {
      get: () => ids,
      subscribe: (listener) => {
        const offs = ids.map((id) => subscribeAgentPresence(id, () => listener()))
        return () => { for (const off of offs) off() }
      },
    }
  }, [idsKey])
  return useSelect(presences, (ids) => {
    const models: Record<string, string> = {}
    for (const id of ids) {
      const payload = getAgentPresenceSnapshot(id)?.payload
      if (payload && payload.accountStatus !== 'removed' && payload.modelName) models[id] = payload.modelName
    }
    return models
  })
}
