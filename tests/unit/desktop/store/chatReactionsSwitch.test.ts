import { describe, expect, it } from 'vitest'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { messageItemFromRow } from '../../../../packages/core/src/cloud/messageItem'
import { message } from '../../../support/testHarness'

describe('reactions across a conversation switch', () => {
  it('keeps known reactions while a reopened chat commits its body-only page, until the overlay read says otherwise', () => {
    const cache = new ChatWindowCache(), history = cache.history('chat'), seen: number[] = []
    const stop = cache.subscribe('chat', (rows) => { seen.push(rows.find((item) => item.id === 'm-1')?.reactions?.length ?? 0) })
    const thumbs = [{ emoji: '👍', count: 2, my_reaction: true }]
    cache.set('chat', [message({ id: 'm-1', chat_id: 'chat', seq: 1, reactions: thumbs })])
    // The switch-time page read: messages_view rows, which carry no reactions.
    const page = [messageItemFromRow({ id: 'm-1', chat_id: 'chat', seq: 1, content: 'hello', content_type: 'text',
      sender_user_id: 'peer-1', created_at: '2026-05-24T00:00:00.000Z' }, 'me')!]
    cache.establishTail('chat', page)
    cache.set('chat', page)
    expect(history.getSnapshot().messages[0].reactions).toEqual(thumbs)
    // The overlay read is authoritative: an explicit empty list clears.
    cache.update('chat', (rows) => rows.map((item) => ({ ...item, reactions: [] })))
    const changes = seen.filter((count, index) => count !== seen[index - 1])
    expect(changes.slice(changes.indexOf(1))).toEqual([1, 0])
    stop()
  })
})
