import { afterEach, expect, it, vi } from 'vitest'
import { message } from '../../../support/testHarness'
import { createMemoryLocalSyncDb } from '../../../../apps/desktop/src/lib/localSyncDb'
import { openImRepository } from '../../../../apps/desktop/src/lib/imRepository'
import { ingestMessages } from '../../../../apps/desktop/src/lib/messageIngest'
import { clearMessageWindows } from '../../../../apps/desktop/src/lib/messageWindows'
import { ChatWindowCache } from '../../../../apps/desktop/src/store/chatWindowCache'
import { bindRepositoryMessageCache } from '../../../../apps/desktop/src/store/chatDiskWindow'
import { enqueueReaction, wishReaction } from '../../../../apps/desktop/src/lib/outbox/kinds/reaction'

// The write itself is the outbox's concern; here it is still in flight.
vi.mock('../../../../apps/desktop/src/lib/outbox/index', () => ({ outbox: () => ({ enqueue: vi.fn(async () => undefined) }) }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({ chatDb: {} }))

const stops: Array<() => void> = []
afterEach(() => { for (const stop of stops.splice(0)) stop(); clearMessageWindows('viewer') })
const row = (id: string, seq: number) => message({ id, seq, chat_id: 'room', sender_user_id: 'peer', to_user_ids: ['viewer'] })

it('a removed reaction stays removed when another write to the chat lands before the removal is confirmed', async () => {
  const repository = await openImRepository('viewer', { adapter: createMemoryLocalSyncDb() })
  const cache = new ChatWindowCache('viewer')
  stops.push(bindRepositoryMessageCache(repository, cache), () => repository.close())
  await ingestMessages('viewer', { writes: [{ type: 'put', message: { ...row('liked', 1), reactions: [{ emoji: '👍', count: 1, my_reaction: true }] } }], revisions: [] })

  // The tap, as the chat store makes it.
  const wish = wishReaction('liked', '👍', cache.rows('room'))
  cache.update('room', (rows) => rows.map(wish.apply))
  await enqueueReaction({ chatId: 'room', messageId: 'liked', userId: 'viewer', emoji: '👍', on: wish.on }, wish.reactions)
  expect(cache.rows('room').find((item) => item.id === 'liked')?.reactions).toEqual([])

  // Someone writes in the chat (a message, a receipt) while the removal is in flight: the window is published again.
  await ingestMessages('viewer', { writes: [{ type: 'put', message: row('next', 2) }], revisions: [] })
  expect(cache.rows('room').map((item) => item.id)).toEqual(['liked', 'next'])
  expect(cache.rows('room').find((item) => item.id === 'liked')?.reactions).toEqual([])
})
