// GUYI-AI/gugu#2548 (刘威提议稿 v1 ③): a row of the desktop one list puts a red number only on what calls you; other news is
// a grey dot. "Calls you" is the server's list_unread_locators.addressed_count — a mention of you, @所有人, a reply to your
// message (a manual mark-unread counts 1) — and every message of a direct chat. The phone keeps its own row number.
import { describe, expect, it } from 'vitest'
import type { ChatItem, ChatKind } from '@gugu/core/shared/types/chat'
import { chatLineCounts, oneListCalls, oneListNewsDot } from '../../../../apps/desktop/src/lib/chatLineUnread'
import { phoneChatUnread } from '../../../../apps/desktop/src/mobile/chat/phoneChatUnread'
import { chat } from '../../../support/testHarness'

/** `count` unread, of which `addressed` call me (mention / @所有人 / reply: the server sums them into addressed_count). */
const unread = (id: string, kind: ChatKind, count: number, addressed: number, extra: Partial<ChatItem> = {}): ChatItem => chat({
  id, kind, unread_count: count, ...extra,
  unread_locator: count === 0 ? null : {
    stream_id: `main:${id}`, stream_kind: 'main', thread_root_id: null, message_id: `${id}-first`, message_seq: 1,
    unread_count: count, addressed_count: addressed, cursor_seq: 0, version: 1, is_marked_unread: false,
  },
})
const topicOf = (source: string, id: string, count: number, addressed: number) => unread(id, 'topic', count, addressed, { source_chat_id: source })

/** What one row of the one list wears. */
const mark = (chats: readonly ChatItem[], id: string) => {
  const calls = oneListCalls(chats).get(id) ?? 0
  return { calls, dot: oneListNewsDot(chats.find((row) => row.id === id)!, calls) }
}

describe('#2548 the one list: a red number only for what calls you', () => {
  it('a group: the calls in its main chat (mention, @所有人, a reply to you), not its other news', () => {
    expect(mark([unread('g', 'group', 5, 2)], 'g')).toEqual({ calls: 2, dot: false })
  })

  it('a direct chat, with a person or an agent: every message calls you', () => {
    expect(mark([unread('dm', 'dm', 3, 0)], 'dm')).toEqual({ calls: 3, dot: false })
    expect(mark([unread('ai', 'ai', 4, 0)], 'ai')).toEqual({ calls: 4, dot: false })
  })

  it('a group whose news calls nobody: a grey dot, no number', () => {
    expect(mark([unread('g', 'group', 4, 0)], 'g')).toEqual({ calls: 0, dot: true })
    expect(mark([chat({ id: 'quiet', kind: 'group', unread_count: 0 })], 'quiet')).toEqual({ calls: 0, dot: false })
  })

  it('a group row adds the calls inside its topics to the calls of its main chat (the proposal\'s 产品讨论群: 3)', () => {
    const chats = [unread('g', 'group', 2, 0), topicOf('g', 't1', 1, 1), topicOf('g', 't2', 1, 1), topicOf('g', 't3', 4, 1), topicOf('g', 'quiet', 9, 0)]
    expect(mark(chats, 'g')).toEqual({ calls: 3, dot: false })
    // A topic call alone lights the row, though the main chat is read.
    expect(mark([chat({ id: 'g', kind: 'group', unread_count: 0 }), topicOf('g', 't', 6, 1)], 'g')).toEqual({ calls: 1, dot: false })
  })

  it('topic news that does not call you does not light the group row, not even as a dot (owner 10-28)', () => {
    expect(mark([chat({ id: 'g', kind: 'group', unread_count: 0 }), topicOf('g', 't', 83, 0)], 'g')).toEqual({ calls: 0, dot: false })
  })

  it('a manual mark-unread is a call (the server counts it 1), and muting does not hide the number in the list', () => {
    const marked = unread('g', 'group', 1, 1, { is_marked_unread: true })
    expect(mark([marked], 'g')).toEqual({ calls: 1, dot: false })
    expect(mark([{ ...unread('g', 'group', 6, 2), is_muted: true }], 'g')).toEqual({ calls: 2, dot: false })
  })
})

describe('the phone keeps its row number: the same folding, its main chat counted in full', () => {
  it('folds topics into their source by the same algorithm, and counts its own main chat whole', () => {
    const chats = [unread('g', 'group', 4, 1), topicOf('g', 't', 6, 2), unread('plain', 'group', 3, 0), unread('dm', 'dm', 2, 0), topicOf('', 'orphan', 5, 5)]
    expect(Object.fromEntries(phoneChatUnread(chats))).toEqual({ g: 6, plain: 3, dm: 2 })
    expect(Object.fromEntries(oneListCalls(chats))).toEqual({ g: 3, plain: 0, dm: 2 })
    // One folding for both: only the per-chat number differs.
    expect(chatLineCounts(chats, (row) => row.unread_count)).toEqual(new Map([['g', 10], ['plain', 3], ['dm', 2]]))
  })
})
