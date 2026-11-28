import { useEffect } from 'react'
import { rendererLogger } from '../../lib/log'
import { myAssistant, type MyAssistant } from '../../lib/myAssistant'
import { platform } from '../../platform'
import { useAuth } from '../../store/auth'
import { rpc } from '../../session/renderer/lib/ipc'

const log = rendererLogger('chat/agent-resource-revisions')

const homeOf = (value: MyAssistant) => `${value.agentId}:${value.provisionDeviceId}`

/**
 * #1927 (42) App pages hearing their binding's agent resources (`gugu.bindings.onResourcesChanged`) hear the assistant's
 * home itself, in main (its files, while it lives on this computer). What only this side sees is told there: the account
 * changed (what main holds for the one before ends), or the assistant moved (`myAssistant`, read again on setup, move,
 * close, focus and bus resume). ❌ A read or a channel of its own.
 */
export function useAgentResourceRevisions(): void {
  const ownerId = useAuth().user?.id ?? null
  useEffect(() => {
    if (!platform.capabilities.agentRuntime) return
    const tell = () => {
      void rpc.extensions.followAssistantHome().catch((error: unknown) => {
        log.warn({ error: error instanceof Error ? error.message : String(error) }, 'telling App pages where the assistant lives failed')
      })
    }
    tell()
    if (!ownerId) return
    const now = myAssistant.entries()[0]?.reading
    let home = now?.state === 'value' ? homeOf(now.value) : null
    return myAssistant.subscribe([], ({ reading }) => {
      if (reading.state !== 'value' || reading.error) return
      const next = homeOf(reading.value)
      if (next !== home) { home = next; tell() }
    })
  }, [ownerId])
}
