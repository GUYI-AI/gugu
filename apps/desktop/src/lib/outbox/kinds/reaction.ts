import type { MessageItem, ReactionGroup } from '@gugu/core/shared/types/chat'
import { dbPayload } from '@gugu/core/cloud/supabase'
import { chatDb } from '../../supabase'
import { outbox, type OutboxKind } from '..'
import { invalidateReactions, persistMessagePatches, readReactionsBehindWishes } from '../../chatMessageRevalidation'

/** What the person wants their reaction to be, not a toggle: a double tap merges into one write of the last wish. */
export type ReactionWish = { chatId: string; messageId: string; userId: string; emoji: string; on: boolean }
const REACTION = 'reaction'

export function reactionOutboxKind(reread: (wish: ReactionWish) => void): OutboxKind<ReactionWish> {
  // Answered (confirmed, refused or dropped): its reads speak again, and the one started now lands the truth (@@@reaction-read-order).
  const answered = (wish: ReactionWish) => { invalidateReactions([wish.messageId]); reread(wish) }
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
    onAck: (item) => answered(item.payload),
    onState: (item) => { if (item.state === 'failed') answered(item.payload) },
    onDiscard: (item) => answered(item.payload),
  }
}

/** Wishes being queued, per message: not in the outbox's rows yet, already unanswered. */
const queuing = new Map<string, number>()

/** Unanswered: being queued, or a row of the outbox that has not failed. A merged double tap is one row, answered by its last wish. */
function wishUnanswered(messageId: string): boolean {
  return (queuing.get(messageId) ?? 0) > 0
    || outbox().items().some((item) => item.kind === REACTION && item.state !== 'failed' && (item.payload as ReactionWish).messageId === messageId)
}

/** The tap is a change: the stored row takes the wish as shown, and no reaction read speaks for the message until it is answered. */
export async function enqueueReaction(wish: ReactionWish, shown: ReactionGroup[]): Promise<unknown> {
  invalidateReactions([wish.messageId])
  queuing.set(wish.messageId, (queuing.get(wish.messageId) ?? 0) + 1)
  try {
    await persistMessagePatches(wish.userId, [{ chatId: wish.chatId, id: wish.messageId, fields: { reactions: shown } }])
    return await outbox().enqueue(REACTION, wish, { id: `reaction:${wish.messageId}:${wish.emoji}` })
  } finally {
    const left = (queuing.get(wish.messageId) ?? 1) - 1
    if (left > 0) queuing.set(wish.messageId, left); else queuing.delete(wish.messageId)
  }
}

/** Registered by the chat store, which re-reads the counts once a wish is answered. */
export function registerReactions(reread: (wish: ReactionWish) => void): () => void {
  const stopKind = outbox().register(reactionOutboxKind(reread))
  const stopReads = readReactionsBehindWishes(wishUnanswered)
  return () => { stopReads(); stopKind() }
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

/** The toggle the person tapped, read from the message as shown: the wish, the groups it shows, and how the rows show it until answered. */
export function wishReaction(messageId: string, emoji: string, ...shown: (readonly MessageItem[])[]): { on: boolean; reactions: ReactionGroup[]; apply: (row: MessageItem) => MessageItem } {
  const message = shown.flat().find((row) => row.id === messageId)
  const on = !message?.reactions?.some((group) => group.emoji === emoji && group.my_reaction)
  return { on, reactions: wishedReactions(message?.reactions ?? [], emoji, on), apply: (row) => row.id === messageId ? { ...row, reactions: wishedReactions(row.reactions ?? [], emoji, on) } : row }
}
