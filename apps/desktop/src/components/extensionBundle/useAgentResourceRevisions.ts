import { useEffect } from 'react'
import { rendererLogger } from '../../lib/log'
import { subscribePrivateUserEventBus, unsubscribePrivateUserEventBus } from '../../lib/realtimeChannel'
import { platform } from '../../platform'
import { useAuth } from '../../store/auth'
import { rpc } from '../../session/renderer/lib/ipc'

const log = rendererLogger('chat/agent-resource-revisions')

/**
 * #1927 (42) App pages hearing their binding's agent resources (`gugu.bindings.onResourcesChanged`). The account's own
 * event bus already carries `assistant_panel_changed` (the assistant's pages hear it there); this passes on which agent's
 * resources changed — and, when the bus joins again or the account changes, that anything may have — and main tells the
 * pages whose grant still holds, or ends theirs. A listener on the bus that is already open, ❌ a channel of its own; a
 * publication commits many resources at once, so a burst is told once.
 */
export function useAgentResourceRevisions(): void {
  const { user } = useAuth()
  const ownerId = user?.id ?? null
  useEffect(() => {
    if (!platform.capabilities.agentRuntime) return
    const tell = (args: { agentIds?: string[]; resync?: boolean }) => {
      void rpc.extensions.agentResourcesChanged(args).catch((error: unknown) => {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'telling App pages their agent resources changed failed')
      })
    }
    // Signed out or another account: what main holds for the one before ends.
    tell({ resync: true })
    if (!ownerId) return
    const changed = new Set<string>()
    let timer: ReturnType<typeof setTimeout> | undefined
    const flush = () => {
      timer = undefined
      const agentIds = [...changed]
      changed.clear()
      if (agentIds.length > 0) tell({ agentIds })
    }
    const handle = subscribePrivateUserEventBus(ownerId, 'assistant_panel_changed', (payload) => {
      const agentId = (payload as { assistantId?: unknown } | null)?.assistantId
      if (typeof agentId !== 'string') return
      changed.add(agentId)
      timer ??= setTimeout(flush, 250)
    }, { onSubscribed: () => tell({ resync: true }) })
    return () => {
      clearTimeout(timer)
      unsubscribePrivateUserEventBus(handle)
    }
  }, [ownerId])
}
