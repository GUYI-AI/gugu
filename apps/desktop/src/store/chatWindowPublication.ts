import { useMemo } from 'react'
import { mergeMessagesById } from '@gugu/core/shared/ui/messageListModels'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import type { AccountImRepository } from '../lib/imRepository'
import { chatService } from '../lib/chat'
import { INITIAL_PAGE, maxMainlineSeq } from './chatMessageWindow'
import { seedCacheFromDisk } from './chatDiskWindow'
import { rendererLogger } from '../lib/log'
import { readMessagePage } from '../lib/messageIngest'
import { messageWindow, setMessageWindow } from '../lib/messageWindows'

import { ChatWindowCache } from './chatWindowCache'
import type { ChatHistoryWindow, FetchHistoryPage } from './chatHistoryWindow'

export function useChatWindowCache(accountId?: string | null) {
  const cache = useMemo(() => new ChatWindowCache(accountId), [accountId])
  return { cache, subscribeChatWindow: cache.subscribe }
}

export type WindowObserver = {
  current: () => boolean
  painted: (rows: MessageItem[], hasMoreOlder?: boolean) => void
  ready: (hasMoreOlder?: boolean) => void
  readSeqs: (seqs: Record<string, number>) => void
}

/** Whether the store holds the conversation's newest page as one verified range (im-message-store `page`). */
export async function storedTailCovered(userId: string, chatId: string): Promise<boolean> {
  const tail = maxMainlineSeq(messageWindow(userId, chatId) ?? [])
  return tail > 0 && (await readMessagePage(userId, { chatId, beforeSeq: tail + 1, limit: INITIAL_PAGE })).covered
}

/**
 * @@@open-by-coverage - one rule opens every conversation, topic and block: paint what is stored; when the stored
 * newest page is a verified range that the account journal keeps current, that is the tail and nothing is read.
 * Otherwise one newest page is read and establishes the tail. Older pages are the reader's to ask for.
 */
export async function openCachedChatWindow(options: {
  chatId: string; userId: string; cache: Map<string, MessageItem[]>; history: ChatHistoryWindow
  getRepository: () => Promise<AccountImRepository>
  /** Whether the account journal delivers this conversation's arrivals and is not a longer backlog behind. */
  journalCurrent: () => Promise<boolean>
  observer: WindowObserver
  commit: (rows: MessageItem[], replaceTail: boolean, hasMoreOlder?: boolean) => void
  revalidate: () => Promise<void>
}): Promise<void> {
  const { chatId, userId, cache, observer } = options
  const repository = await options.getRepository()
  if (!observer.current()) return
  const disk = seedCacheFromDisk(cache, repository, chatId)
  let painted = !!cache.get(chatId)?.some((message) => message.seq >= 0)
  if (disk) { observer.painted(disk.rows, disk.hasMoreOlder); painted = true }
  const readSeqs = chatService.getOtherMembersReadSeqs(chatId, userId)
    .then((seqs) => { if (observer.current()) observer.readSeqs(seqs) })
    .catch((error: unknown) => rendererLogger('chat/window').error({ error, chatId }, 'member read seqs load failed'))
  const current = (await options.journalCurrent()) && await storedTailCovered(userId, chatId)
  if (!observer.current()) return
  const finalize = async (rows: MessageItem[], replaceTail: boolean, hasMoreOlder?: boolean) => {
    if (!observer.current()) return
    options.commit(rows, replaceTail, hasMoreOlder)
    observer.ready(hasMoreOlder)
    await Promise.all([options.revalidate(), readSeqs])
  }
  if (current) {
    await finalize(cache.get(chatId) ?? [], false)
    return
  }
  if (!painted) {
    await options.history.load('latest', fetchChatHistoryPage(userId))
    const window = options.history.getSnapshot()
    await finalize(window.messages, true, window.hasOlder)
  } else {
    const rows = await chatService.getMessages(chatId, userId, 'initialLoad', INITIAL_PAGE)
    await finalize(rows, true, true)
  }
}

/** The existing history controller owns both primary and scoped pagination. */
export function fetchChatHistoryPage(userId: string): FetchHistoryPage {
  return async (chatId, way, cursor, limit) => {
    if (way === 'older') {
      const local = await readMessagePage(userId, { chatId, beforeSeq: cursor, limit })
      if (local.covered) return local.rows
    }
    return way === 'newer'
      ? chatService.getMessages(chatId, userId, 'loadNewer', limit, undefined, cursor)
      : way === 'older' ? chatService.getMessages(chatId, userId, 'loadOlder', limit, cursor)
        : chatService.getMessages(chatId, userId, 'initialLoad', limit)
  }
}

export function restoreChatHistoryAnchor(window: ChatHistoryWindow, userId: string, messageId: string): Promise<boolean> {
  return window.restoreAnchor(async (chatId) => {
    const anchor = await chatService.getMessageById(messageId, userId)
    if (!anchor || anchor.chat_id !== chatId || anchor.thread_root_id) throw new Error('Saved conversation message is no longer available')
    const [older, newer] = await Promise.all([
      chatService.getMessages(chatId, userId, 'loadOlder', 20, anchor.seq + 1),
      chatService.getMessages(chatId, userId, 'loadNewer', 20, undefined, anchor.seq),
    ])
    const messages = mergeMessagesById(older, newer, chatId)
    if (!messages.some((row) => row.id === messageId)) throw new Error('Saved conversation message is no longer visible')
    return { messages, hasNewer: newer.length === 20 }
  })
}

/** Paint the bounded local thread before its ordinary network revalidation. The caller owns its race guard. */
export async function fetchThreadMessages(chatId: string, rootId: string, userId: string,
  publishLocal: (rows: MessageItem[]) => void): Promise<MessageItem[]> {
  const local = await readMessagePage(userId, { chatId, threadRootId: rootId, limit: 100 })
  if (local.rows.length) {
    setMessageWindow(userId, chatId, rootId, local.rows)
    publishLocal(local.rows)
  }
  return chatService.getThreadMessages(chatId, rootId, userId, 100)
}
