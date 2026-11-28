import { messageItemFromRow, type RawMessageRow } from '@gugu/core/cloud/messageItem'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { ingestMessagePage } from './messageIngest'
import { applyMessageOverlays } from './chatMessageRevalidation'

/** Canonical network rows enter the store before a caller can publish them to a view. */
export async function ingestFetchedMessagePage(raw: RawMessageRow[], userId: string, page: {
  chatId: string; limit: number; beforeSeq?: number; afterSeq?: number; threadRootId?: string
}): Promise<MessageItem[]> {
  let rows = raw.map(row => messageItemFromRow(row, userId)).filter((row): row is MessageItem => row !== null)
  if (page.afterSeq === undefined) rows.reverse()
  if (page.threadRootId) rows = await applyMessageOverlays(rows, userId)
  const accepted = await ingestMessagePage(userId, rows, page.chatId, page.limit, page.beforeSeq, page.afterSeq, page.threadRootId ?? null, raw.length)
  // The store refuses the rows this device hides (@@@local-hide); the page shown must not bring them back either.
  const kept = new Set(accepted.flatMap(write => write.type === 'put' ? [write.message.id] : []))
  return rows.filter(row => kept.has(row.id))
}
