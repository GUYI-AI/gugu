import type { TranscriptTurn } from '@gugu/session-core/acp/client'
import type { PendingPrompt } from '@gugu/session-chat-ui'
import { readDeliveryEnvelope } from '@gugu/core/local/agent/deliveryEnvelope'
import { projectSessionPendingInput, sessionInputBaseline } from '@/lib/pendingSessionInput'
import type { HostPendingRow, SessionInput } from '@/lib/sessionInputOutbox'

/**
 * This phone's queue inputs the page cannot place yet (#2367). The send queue releases an input once the record its
 * releaser read has the previous turn settled, and records that turn as `afterTurnId`. This page draws its own record,
 * which can still hold that turn as the running one for a moment; drawn now, the bubble goes under the running turn and
 * is pushed down a row, its row replaced, when the settled turn's last rows arrive. Whatever source would draw it (the
 * sender row, or the host's queue row once the host has it), the input stays in the queue until this page's record
 * has that turn. Each input is judged once: one that could be placed when it was released is never held later.
 */
export type PhoneRecordWait = { sessionId: string; waiting: ReadonlyMap<string, { afterTurnId: string; text: string }>; judged: ReadonlySet<string> }

export function phoneRecordWait(previous: PhoneRecordWait | null, sessionId: string, sender: readonly SessionInput[],
  turns: readonly TranscriptTurn[]): PhoneRecordWait {
  const kept = previous?.sessionId === sessionId ? previous : null
  const placed = (turnId: string) => turns.some(turn => turn.id === turnId)
  const waiting = new Map([...kept?.waiting ?? []].filter(([, input]) => !placed(input.afterTurnId)))
  const judged = new Set(kept?.judged)
  for (const input of sender) {
    if (!input.releasedFromQueue || judged.has(input.id)) continue
    judged.add(input.id)
    if (input.afterTurnId !== undefined && !placed(input.afterTurnId)) waiting.set(input.id, { afterTurnId: input.afterTurnId, text: input.text })
  }
  return kept && waiting.size === kept.waiting.size && judged.size === kept.judged.size ? kept : { sessionId, waiting, judged }
}

/** A phone can discover another client's already-sent input in the host queue before seeing its native echo. */
export function projectPhonePendingInputs(previous: readonly PendingPrompt[], sender: readonly SessionInput[],
  host: readonly HostPendingRow[], turns: readonly TranscriptTurn[]): PendingPrompt[] {
  const ordinary = host.filter(input => input.kind === 'ordinary' && !readDeliveryEnvelope(input.text))
  const ids = new Set([...previous.map(input => input.id), ...sender.filter(input => input.queued === false && !input.sendQueue).map(input => input.id),
    ...ordinary.map(input => input.messageId)])
  return [...ids].flatMap(id => {
    const receipt = ordinary.find(input => input.messageId === id)
    let prior: PendingPrompt | null = previous.find(input => input.id === id) ?? (receipt ? { id, text: receipt.text, held: true, ...(receipt.sentAt !== undefined ? { sentAt: receipt.sentAt } : {}),
      baselineMessageIds: sessionInputBaseline(turns).baseline, afterTurnId: turns.at(-1)?.id,
      delivery: { state: 'sending' as const } } : null)
    const ownSender = sender.filter(input => input.id === id)
    const foreign: string[] = []
    for (const turn of turns) for (const item of turn.items) if (item.kind === 'message' && item.role === 'user') {
      const clientId = item._meta?.guguClientMessageId
      if (typeof clientId !== 'string') continue
      if (clientId === id) return []
      foreign.push(item.id)
    }
    // Two identical messages are distinct inputs: an explicitly identified echo cannot settle its neighbour.
    if (prior && foreign.length) prior = { ...prior, baselineMessageIds: [...new Set([...(prior.baselineMessageIds ?? []), ...foreign])] }
    const prompt = projectSessionPendingInput(prior, ownSender.map(input => foreign.length ? { ...input, baseline: [...new Set([...(input.baseline ?? []), ...foreign])] } : input), host, turns)
    return prompt ? [prompt] : []
  })
}
