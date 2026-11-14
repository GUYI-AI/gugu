import { useEffect, useMemo, useSyncExternalStore } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { MessageAgentWakes, MessageRecipientFacts } from '@gugu/core/shared/ui/messageState'
import { deliveryWaits as deriveDeliveryWaits, type HeldMessage } from '@gugu/core/shared/ui/systemNotice'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import { knownMessageAgentWakes, knownMessageAgentWakesKey, requestMessageAgentWakes, subscribeMessageAgentWakes } from '@/lib/messageAgentWakes'

/**
 * Who my messages are delivered to, and which of them still wait for an agent no running instance can reach.
 * One source for the main line, a topic and Quick Chat: the agents each message wakes and the line's agents.
 * The read receipt's denominators and the delivery waits both come from it.
 */
export function useMessageDelivery(
  messages: readonly MessageItem[],
  memberReadSeqs: Record<string, number>,
  memberProfiles: Record<string, MemberProfileCardModel> = {},
): { recipientFacts: MessageRecipientFacts; deliveryWaits: ReadonlyMap<string, HeldMessage> } {
  const mine = useMemo(() => messages
    .filter((message) => message.is_mine && message.seq > 0 && !message.retracted_at)
    .map((message) => message.id), [messages])
  // Wakes never change once known, so this view's map only changes when the set of its known ids does: rows keep
  // their memo across unrelated store changes (see MessageList's #1163 note).
  const knownKey = useSyncExternalStore(subscribeMessageAgentWakes, () => knownMessageAgentWakesKey(mine))
  useEffect(() => { requestMessageAgentWakes(mine) }, [mine, knownKey])
  const wakes = useMemo<MessageAgentWakes>(
    () => new Map(knownKey ? knownKey.split(',').map((id) => [id, knownMessageAgentWakes(id)!]) : []),
    [knownKey],
  )
  const agentKey = useMemo(() => Object.values(memberProfiles).filter((profile) => profile.type === 'agent').map((profile) => profile.id).sort().join(','), [memberProfiles])
  const agentIds = useMemo(() => new Set(agentKey ? agentKey.split(',') : []), [agentKey])
  const recipientFacts = useMemo(() => ({ agentIds, wakes }), [agentIds, wakes])
  const deliveryWaits = useMemo(() => deriveDeliveryWaits(messages, memberReadSeqs, wakes), [messages, memberReadSeqs, wakes])
  return { recipientFacts, deliveryWaits }
}
