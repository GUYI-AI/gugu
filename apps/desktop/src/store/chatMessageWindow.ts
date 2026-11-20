import type { MessageItem } from '@gugu/core/shared/types/chat'

// @@@chat-window (#504) - cap the in-memory message window. A long-open chat (realtime appending all
// @@@small-window (#946 回港 #4644/#5b) - cap initial render/cache to ~tens, not hundreds:Virtuoso 首屏过取
// 几百条导致卡顿,首屏窗口降到 ~tens(at-tail render/cache cap;MAX_WINDOW 随之 120)。
export const MESSAGE_WINDOW = 40
// @@@chat-isolation - when scrolled up reading older history (loadOlder), allow the
// list to grow up to MAX_WINDOW. ChatHistoryWindow moves this bounded range in both directions,
// preserving retained message indices. Non-active chats trim to MESSAGE_WINDOW; the active window opens
// at MESSAGE_WINDOW and stays there while following the tail (see @@@tail-window in chatHistoryWindow.ts).
export const MAX_WINDOW = MESSAGE_WINDOW * 3
export const OLDER_PAGE = 60
// @@@small-window (#946 回港 #4644/#5b) - cold-open 只取这么多(vs getMessages 默认 60),约束首屏请求+渲染到
// ~tens。hasMoreOlder 以此为准(取满一整页 ⇒ 还有更旧)。loadOlder/toggleReaction 走默认,不受影响。
export const INITIAL_PAGE = 30
// @@@msg-cache-incremental (#621) - max NEW messages fetched in one incremental gap-heal (seq > maxSeq).
// A chat away for a long time could accrue many; page ceiling matches the older-history page.
export const NEWER_PAGE = 200

export function trimToMessageWindow(messages: MessageItem[]): MessageItem[] {
  if (messages.length <= MESSAGE_WINDOW) return messages
  const settled = messages.filter(row => row.seq > 0)
  const capacity = Math.max(0, MESSAGE_WINDOW - (messages.length - settled.length))
  const kept = new Set((capacity ? settled.slice(-capacity) : []).map(row => row.id))
  return messages.filter(row => row.seq < 1 || kept.has(row.id))
}

// 窗口(缓存)已落定行的最大 seq。seq 从 1 起(004_chat_extensions.sql:next_message_seq DEFAULT 1、
// RETURNING next-1),所以 0 = 「没有已验证尾」;乐观行(seq<0)不参与。
export function maxMainlineSeq(rows: readonly MessageItem[] | undefined): number {
  let max = 0
  for (const m of rows ?? []) if (m.seq > max) max = m.seq
  return max
}
