import { readDeliveryEnvelope, type DeliveryReadFacts } from '../local/agent/deliveryEnvelope'

export type TimelineRailSenderType = 'human' | 'agent'

export interface TimelineRailOptions {
  selfUserId?: string | null
  /** Historical envelopes lack from_type. Resolve their typed sender address from the identity directory. */
  resolveSenderType?: (fromId: string) => TimelineRailSenderType | null | undefined
}

export interface TimelineRailMessage {
  text: string
  /** null is a person's direct input; deliveries retain the source and sender facts. */
  sender: DeliveryReadFacts | null
}

/** The silence control token is never preview copy, including when adjacent to reply text. */
export function timelineRailPreviewText(text: string): string {
  return text.replaceAll('[NO_REPLY]', '').trim()
}

/**
 * Human inputs eligible for a timeline rail. Empty means no marker or preview.
 * Batches are filtered segment by segment so agent text cannot leak into a human preview.
 * Unknown historical senders wait for directory resolution instead of being assumed human.
 */
export function timelineRailMessages(text: string, options: TimelineRailOptions = {}): TimelineRailMessage[] {
  return timelineRailCandidates(text).filter((message) => timelineRailAdmits(message, options))
}

/**
 * The inputs of a text that some reader's rail could show: everything `timelineRailMessages` keeps for one identity
 * directory or another. What it leaves out needs no directory to rule out (a session's direct message, a system or
 * scheduled delivery, an agent's). A reader that has only this list and its own directory finishes with
 * `timelineRailAdmits` and gets what `timelineRailMessages` gives it from the text.
 */
export function timelineRailCandidates(text: string): TimelineRailMessage[] {
  const delivery = readDeliveryEnvelope(text)
  if (!delivery) {
    const prompt = timelineRailPreviewText(text)
    return prompt ? [{ text: prompt, sender: null }] : []
  }
  return delivery.segments.flatMap(({ body, facts }) => {
    const prompt = timelineRailPreviewText(body)
    if (!prompt || !facts) return []
    if (facts.route === 'session-direct' || facts.route === 'system' || facts.route === 'scheduled') return []
    if (facts.fromType === 'agent' || /^(?:session|agent|system):/.test(facts.fromId ?? '')) return []
    return [{ text: prompt, sender: facts }]
  })
}

/** Whether this reader's rail shows a candidate: a person's own input, or a delivery its directory knows to be a human's. */
export function timelineRailAdmits(message: Pick<TimelineRailMessage, 'sender'>, options: TimelineRailOptions = {}): boolean {
  const facts = message.sender
  if (!facts) return true
  const senderType = facts.fromType ?? (facts.fromId ? options.resolveSenderType?.(facts.fromId) : null)
  const isSelf = !!options.selfUserId && facts.fromId === `user:${options.selfUserId}`
  // App interactions are explicitly relayed on the person's behalf by this route.
  if (senderType !== 'human' && !isSelf && facts.route !== 'extension') return false
  return senderType !== 'agent'
}
