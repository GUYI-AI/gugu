// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { subscribeChatLineRevisions, type ChatLine } from '../../../../apps/desktop/src/lib/accountRevisionListeners'
import type { AccountRevisionListener } from '../../../../apps/desktop/src/lib/accountRevisionCoordinator'
import type { AccountRevisionOperation } from '../../../../apps/desktop/src/lib/accountRevisionRuntime'
import { message } from '../../../support/testHarness'

vi.mock('../../../../apps/desktop/src/lib/chat', () => ({ chatService: {} }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {} }))
const stored = vi.hoisted(() => ({ rows: [] as MessageItem[], marks: [] as { rootId: string; seq: number }[] }))
vi.mock('../../../../apps/desktop/src/lib/messageIngest', () => ({
  readMessagePage: async (_account: string, page: { ids: string[] }) => ({ rows: stored.rows.filter((row) => page.ids.includes(row.id)), covered: true }),
}))
vi.mock('../../../../apps/desktop/src/lib/chatUnreadLocator', () => ({
  markLatestThreadRead: (_chatId: string, rootId: string, rows: MessageItem[]) => { stored.marks.push({ rootId, seq: Math.max(...rows.map((row) => row.seq)) }) },
}))

const main = message({ id: 'main-1', chat_id: 'chat-1', seq: 10 })
const reply = message({ id: 'reply-1', chat_id: 'chat-1', seq: 11, thread_root_id: 'root-1' })
const created = (row: MessageItem): AccountRevisionOperation => ({ revision: String(row.seq), event: 'message_created', payload: {
  chat_id: 'chat-1', entity_id: row.id, tombstone: false,
  message: { id: row.id, chat_id: 'chat-1', seq: row.seq, thread_root_id: row.thread_root_id ?? null },
} })

function openLine(threadRootId: string | null) {
  const listeners = new Map<string, AccountRevisionListener>()
  let thread: MessageItem[] = threadRootId ? [message({ id: threadRootId, chat_id: 'chat-1', seq: 5 })] : []
  const line: ChatLine = {
    userId: 'viewer', chatId: () => 'chat-1', maxSeqOf: () => 10, getMessageSnapshotEpoch: () => 0,
    readCommittedMessage: (id) => [main].find((row) => row.id === id),
    threadRootId: () => threadRootId, ownsThread: () => false,
    noteCommittedMessages: vi.fn(), applyMessagesSnapshot: vi.fn(), healMessageGap: vi.fn(async () => {}), revalidateWindowOverlays: vi.fn(),
    setMessagesAndCache: vi.fn(), setThreadMessages: (update) => { thread = typeof update === 'function' ? update(thread) : update },
    memberReadSeqsChatRef: { current: 'chat-1' }, setMemberReadSeqs: vi.fn(), readMemberReadSeqs: () => ({}),
  }
  subscribeChatLineRevisions((event, listener) => { listeners.set(event, listener); return () => {} }, line)
  const arrive = (...rows: MessageItem[]) => listeners.get('message_created')!(rows.map(created))
  return { line, arrive, thread: () => thread.map((row) => row.id) }
}

describe('a thread reply arriving on an open conversation line', () => {
  beforeEach(() => { stored.rows = [main, reply]; stored.marks = [] })

  it('is not a main-timeline gap: the main timeline reads nothing for it', async () => {
    const { line, arrive } = openLine(null)
    await arrive(reply)
    expect(line.healMessageGap).not.toHaveBeenCalled()
    expect(line.noteCommittedMessages).not.toHaveBeenCalled()
  })

  it('reaches its open thread from the store and marks that thread read, without a read', async () => {
    const { line, arrive, thread } = openLine('root-1')
    await arrive(reply, main)
    expect(line.healMessageGap).not.toHaveBeenCalled()
    expect(thread()).toEqual(['root-1', 'reply-1'])
    expect(stored.marks).toEqual([{ rootId: 'root-1', seq: 11 }])
    expect(line.noteCommittedMessages).toHaveBeenCalledWith('chat-1', [main])
  })

  it('leaves another open thread alone', async () => {
    const { line, arrive, thread } = openLine('root-2')
    await arrive(reply)
    expect(line.healMessageGap).not.toHaveBeenCalled()
    expect(thread()).toEqual(['root-2'])
    expect(stored.marks).toEqual([])
  })

  it('repairs with the read when the store does not hold the reply', async () => {
    stored.rows = [main]
    const { line, arrive } = openLine('root-1')
    await arrive(reply)
    expect(line.healMessageGap).toHaveBeenCalledWith('chat-1', true)
  })
})
