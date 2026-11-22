import type { MessageItem } from '@gugu/core/shared/types/chat'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import type { AccountImRepository } from '../lib/imRepository'
import { trimToMessageWindow } from './chatMessageWindow'
import { messageWindow, publishMessageWindows } from '../lib/messageWindows'
import type { ChatWindowCache } from './chatWindowCache'
import { recordNativeConversationHistoryClear } from '../lib/nativeConversationHistoryClear'

/** One account commit feeds every viewport, including conversations not open yet. */
export function bindRepositoryMessageCache(repository: AccountImRepository, cache: ChatWindowCache): () => void {
  // Windows come from the message store (messageIngest); the repository carries no message rows.
  publishMessageWindows(repository.accountId, (chatId, rows, deletedIds) => {
    if (!rows) cache.delete(chatId)
    else if (!deletedIds) cache.set(chatId, rows)
    else if (cache.rows(chatId).some(row => deletedIds.includes(row.id))) cache.update(chatId, previous => previous.filter(row => !deletedIds.includes(row.id)))
  })
  let previous: ReturnType<AccountImRepository['snapshot']> | undefined
  return repository.subscribe(snapshot => snapshot, snapshot => {
    for (const row of snapshot.chat) {
      cache.clearHistoryBefore(row.id, row.value.conversation_cleared_at)
      recordNativeConversationHistoryClear(repository.accountId, row.id, row.value.conversation_cleared_at)
    }
    if (previous && previous.chat !== snapshot.chat) {
      for (const row of previous.chat) if (!snapshot.chat.some(chat => chat.id === row.id)) cache.delete(row.id)
    }
    previous = snapshot
  })
}

/**
 * 盘上(L2)的消息窗 → 这条会话现在就能画的行。盘读是同步的:仓库开着时,点开一条会话的**同一帧**
 * 就把上次的内容画出来,而不是先画一帧骨架/空态再等下一拍 —— 那一帧就是用户看到的「一闪」。
 *
 * - 按 chat_id 过滤 + 裁到窗口(防串会话,与内存缓存同一契约)。
 * - 内存里只有未落定的乐观行(outbox)不算已缓存:与盘上的窗合并。
 * - L1 已有落定行时不回灌迟到的盘窗;账号新消息由上面的提交订阅推入同一 L1。
 */
export function paintableDiskWindow(repository: AccountImRepository, chatId: string, live: MessageItem[] | undefined): { rows: MessageItem[]; hasMoreOlder: boolean } | null {
  if (live?.some(message => message.seq >= 0)) return null
  const local = messageWindow(repository.accountId, chatId) ?? []
  const rows = trimToMessageWindow(local.filter((message) => message.chat_id === chatId))
  if (rows.length === 0) return null
  return { rows: trimToMessageWindow(mergeMessagesById(live ?? [], rows, chatId)), hasMoreOlder: (local[0]?.seq ?? 1) > 1 }
}

/** 盘上的窗能画就写进内存缓存(同一份判定),返回写进去的那份;画不了返回 null、缓存不动。 */
export function seedCacheFromDisk(cache: Map<string, MessageItem[]>, repository: AccountImRepository, chatId: string): { rows: MessageItem[]; hasMoreOlder: boolean } | null {
  const disk = paintableDiskWindow(repository, chatId, cache.get(chatId))
  if (disk) cache.set(chatId, disk.rows)
  return disk
}
