import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import { pendingEchoes, pendingPromptLanded, type PendingPrompt } from '@session-chat/state/pending-prompt'
import { assistantTimelineClient } from '@/components/assistant/assistantTimelineClient'
import { loadPendingDeliveryHistory } from '@/lib/pendingSessionDeliveries'
import { messageForUser } from '@/lib/userFacingError'
import { fetchOlder } from './sessionpage-rpc'

/**
 * Only unknown receipts resolve older timeline pages; normal first paint and its requests stay unchanged. The pages
 * read go before the turns the timeline holds (they are older than its first).
 */
export function usePendingDeliveryHistory({ deviceId, sessionId, local, enabled, ready, hasOlder, turns, inputs }: {
  deviceId: string; sessionId: string; local: boolean; enabled: boolean; ready: boolean; hasOlder: boolean
  turns: readonly TranscriptTurn[]; inputs: readonly PendingPrompt[]
}) {
  const key = `${local ? 'local' : deviceId}/${sessionId}`
  const [read, setRead] = useState<{ key: string; extra: readonly TranscriptTurn[]; resolved: readonly string[]; error: string | null }>({ key, extra: [], resolved: [], error: null })
  const own: Pick<typeof read, 'extra' | 'resolved' | 'error'> = read.key === key ? read : { extra: [], resolved: [], error: null }
  const merged = useMemo(() => {
    if (!own.extra.length) return turns
    const held = new Set(turns.map(turn => turn.id))
    return [...own.extra.filter(turn => !held.has(turn.id)), ...turns]
  }, [turns, own.extra])
  const echoes = useMemo(() => pendingEchoes(merged), [merged])
  const unknownKey = inputs.filter(input => input.delivery?.state === 'unknown' && !own.resolved.includes(input.id)
    && !pendingPromptLanded(input, echoes)).map(input => input.id).sort().join('\0')
  const current = useRef({ inputs, turns: merged, hasOlder })
  current.current = { inputs, turns: merged, hasOlder }
  useEffect(() => {
    if (!ready || !unknownKey) return
    let alive = true
    const ids = unknownKey.split('\0')
    const snapshot = current.current
    const finish = (extra: readonly TranscriptTurn[], error: string | null) => {
      if (!alive) return
      setRead(previous => {
        const prior = previous.key === key ? previous : { extra: [], resolved: [] }
        const known = new Set(extra.map(turn => turn.id))
        return { key, extra: [...extra, ...prior.extra.filter(turn => !known.has(turn.id))], resolved: [...new Set([...prior.resolved, ...ids])], error }
      })
    }
    const client = local ? assistantTimelineClient(true) : { fetchOlder }
    let before = enabled && snapshot.hasOlder ? snapshot.turns[0]?.id ?? null : null
    const readOlder = async () => {
      const page = await client.fetchOlder(deviceId, sessionId, before!, 100)
      if (page.hasOlder && !page.turns.length) throw new Error('Session history did not move back')
      before = page.hasOlder ? page.turns[0]?.id ?? null : null
      return { turns: page.turns, hasOlder: before !== null }
    }
    void loadPendingDeliveryHistory(snapshot.turns, before !== null,
      snapshot.inputs.filter(input => ids.includes(input.id)), readOlder, () => alive)
      .then(result => finish(result.turns, null), (error: unknown) => finish([], messageForUser(error)))
    return () => { alive = false }
  }, [key, deviceId, sessionId, local, enabled, ready, unknownKey])
  const visible = useCallback((input: PendingPrompt) => input.delivery?.state !== 'unknown'
    || (ready && (own.resolved.includes(input.id) || pendingPromptLanded(input, echoes))), [ready, own.resolved, echoes])
  return { turns: merged, error: own.error, visible }
}
