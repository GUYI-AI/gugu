import { useCallback, useEffect, useState } from 'react'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { deriveReadReceipt, type MessageRecipientFacts } from '@gugu/core/shared/ui/messageState'
import type { HeldMessage } from '@gugu/core/shared/ui/systemNotice'
import type { MemberProfileCardModel } from '@/components/MemberProfileCard'
import type { ReadReceiptMember } from '@/components/ReadReceiptPopover'
import { Popover } from '@/components/ui/Popover'

/** 一个会话里所有已读圆环共用一张名单浮层:每颗环是它的 Trigger(payload = 消息 id),再点同一颗环就关、点另一颗名单换过去。 */
export type ReadReceiptHandle = ReturnType<typeof Popover.createHandle<string>>

/** 主线和话题共用名单派生；消息、读位、收件方和未送达（useMessageDelivery）必须来自当前这条会话。 */
export function useReadReceiptPanel({ chatId, messages, memberReadSeqs, memberProfiles, recipientFacts, deliveryWaits }: {
  chatId: string | null
  messages: readonly MessageItem[]
  memberReadSeqs: Record<string, number>
  memberProfiles: Record<string, MemberProfileCardModel>
  recipientFacts: MessageRecipientFacts
  deliveryWaits: ReadonlyMap<string, HeldMessage>
}) {
  const [handle] = useState(() => Popover.createHandle<string>())
  useEffect(() => { handle.close() }, [chatId, handle])

  const receiptOf = useCallback((messageId: string) => {
    const message = messages.find((item) => item.id === messageId)
    if (!message || message.retracted_at) return null
    const receipt = deriveReadReceipt(message, memberReadSeqs, recipientFacts, {
      messageReaders: message.readers?.length ? { [message.id]: new Set(message.readers) } : {},
    })
    if (!receipt) return null
    const undelivered = new Set(deliveryWaits.get(message.id)?.undeliveredTo)
    const toMember = (id: string): ReadReceiptMember => {
      const profile = memberProfiles[id]
      return { id, displayName: profile?.displayName ?? id, avatar: profile?.avatar ?? null, isAgent: profile?.type === 'agent', agentStatus: profile?.agentStatus, undelivered: undelivered.has(id) }
    }
    const readers = new Set(receipt.readerIds)
    return {
      readers: receipt.readerIds.map(toMember),
      unreaders: receipt.recipientIds.filter((id) => !readers.has(id)).map(toMember),
    }
  }, [messages, memberReadSeqs, memberProfiles, recipientFacts, deliveryWaits])

  return { readReceiptHandle: handle, receiptOf }
}
