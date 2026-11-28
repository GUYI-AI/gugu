// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
import { chatService } from '../../../../apps/desktop/src/lib/chat'
import { applyReactionChangedEvents } from '../../../../apps/desktop/src/store/chatRealtimeMutations'
vi.mock('../../../../apps/desktop/src/lib/log', () => ({ rendererLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }))

const row = (id: string, reactions: MessageItem['reactions'] = []) => ({ id, chat_id: 'chat-1', reactions }) as MessageItem

describe('reaction changes of one batch', () => {
  it('read the overlays of every touched message at once and patch only rows still behind', async () => {
    const thumbs = [{ emoji: '👍', count: 1, my_reaction: false }]
    const read = vi.spyOn(chatService, 'fetchMessageOverlays').mockImplementation(async (messages) =>
      new Map(messages.filter(message => message.id !== 'gone').map(message => [message.id, { reactions: thumbs, delivered: false, delivery_status: null, readers: [], delivery_blocks: [] }])))
    let rows = [row('a'), row('b', thumbs), row('c')]
    const setMessagesAndCache = vi.fn((update: (prev: MessageItem[]) => MessageItem[]) => { rows = update(rows) })
    await applyReactionChangedEvents(['a', 'b', 'gone'], 'me', 'chat-1', { setMessagesAndCache, setThreadMessages: vi.fn() })
    expect(read).toHaveBeenCalledTimes(1)
    expect(read.mock.calls[0]![0].map(message => message.id)).toEqual(['a', 'b', 'gone'])
    expect(rows.map(message => message.reactions)).toEqual([thumbs, thumbs, []])
    read.mockRestore()
  })
})
