import type { MessageItem, ReactionGroup } from '@gugu/core/shared/types/chat'
import { dbPayload } from '@gugu/core/cloud/supabase'
import { chatDb } from '../../supabase'
import { outbox, type OutboxKind } from '..'
import { invalidateReactions } from '../../chatMessageRevalidation'

/** What the person wants their reaction to be, not a toggle: a double tap merges into one write of the last wish. */
export type ReactionWish = { chatId: string; messageId: string; userId: string; emoji: string; on: boolean }
const REACTION = 'reaction'

export function reactionOutboxKind(onAck: (wish: ReactionWish) => void): OutboxKind<ReactionWish> {
  return {
    name: REACTION,
    lane: (wish) => `reaction:${wish.messageId}`,
    merge: (_previous, next) => next,
    async send({ payload: { messageId, userId, emoji, on } }) {
      // Both are idempotent on the unique (message_id, user_id, emoji): adding twice keeps one, removing twice removes none.
      if (on) {
        await chatDb.from('message_reactions')
          .upsert(dbPayload({ id: crypto.randomUUID(), message_id: messageId, user_id: userId, emoji }), { onConflict: 'message_id,user_id,emoji', ignoreDuplicates: true })
          .throwOnError()
      } else {
        await chatDb.from('message_reactions').delete().eq('message_id', messageId).eq('user_id', userId).eq('emoji', emoji).throwOnError()
      }
    },
    // A reaction read begun before this write may not see it (@@@reaction-read-order).
    onAck: (item) => { invalidateReactions([item.payload.messageId]); onAck(item.payload) },
  }
}

export function enqueueReaction(wish: ReactionWish): Promise<unknown> {
  return outbox().enqueue(REACTION, wish, { id: `reaction:${wish.messageId}:${wish.emoji}` })
}

/** Registered by the chat store, which re-reads the confirmed counts. */
export function registerReactions(onAck: (wish: ReactionWish) => void): () => void {
  return outbox().register(reactionOutboxKind(onAck))
}

/** The groups as the wish shows them until the confirmed counts are read back. */
export function wishedReactions(groups: readonly ReactionGroup[], emoji: string, on: boolean): ReactionGroup[] {
  const group = groups.find((row) => row.emoji === emoji)
  if (on) {
    if (group?.my_reaction) return [...groups]
    return group ? groups.map((row) => row === group ? { ...row, count: row.count + 1, my_reaction: true } : row) : [...groups, { emoji, count: 1, my_reaction: true }]
  }
  if (!group?.my_reaction) return [...groups]
  return groups.flatMap((row) => row !== group ? [row] : row.count > 1 ? [{ ...row, count: row.count - 1, my_reaction: false }] : [])
}

/** The toggle the person tapped, read from the message as shown: the wish, and how the rows show it until confirmed. */
export function wishReaction(messageId: string, emoji: string, ...shown: (readonly MessageItem[])[]): { on: boolean; apply: (row: MessageItem) => MessageItem } {
  const message = shown.flat().find((row) => row.id === messageId)
  const on = !message?.reactions?.some((group) => group.emoji === emoji && group.my_reaction)
  return { on, apply: (row) => row.id === messageId ? { ...row, reactions: wishedReactions(row.reactions ?? [], emoji, on) } : row }
}
