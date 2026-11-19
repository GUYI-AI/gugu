import type { MessageItem } from '@gugu/core/shared/types/chat'
import { messageItemFromRow, MESSAGES_VIEW_SELECT, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import { idPrefixMatches, uuidPrefixRange } from '@gugu/core/shared/idPrefix'
import { chatDb } from './supabase'

/**
 * The messages of one chat a `msg:<prefix>` names, as the person reading may see them (owner 2026-11-16): the same
 * matcher as the agent tools (idPrefix.ts) over this chat's live messages, newest first. One row: that message; several:
 * the candidates; none: no such message here. At most 11 are read — enough to say "several".
 */
export async function messagesByIdPrefix(chatId: string, prefix: string, userId: string): Promise<MessageItem[]> {
  const range = uuidPrefixRange(prefix)
  if (!range) return []
  const { data, error } = await chatDb
    .from('messages_view')
    .select(MESSAGES_VIEW_SELECT)
    .eq('chat_id', chatId)
    .gte('id', range.lo).lte('id', range.hi)
    .is('deleted_at', null).not('deleted_for_user_ids', 'cs', JSON.stringify([userId]))
    .order('created_at', { ascending: false })
    .limit(11)
  if (error) throw new Error(error.message)
  const items = (data ?? []).flatMap((row) => messageItemFromRow(row as RawMessageRow, userId) ?? [])
  return idPrefixMatches(prefix, items, (item) => item.id).map(([, item]) => item)
}
