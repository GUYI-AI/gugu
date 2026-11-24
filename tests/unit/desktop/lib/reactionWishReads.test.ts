// A reaction wish speaks for its message until the server answers it: no read that lands meanwhile may paint an older
// value back (a removed 👍 came back, then went away again).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem, ReactionGroup } from '@gugu/core/shared/types/chat'
import { createOutbox, type Outbox } from '../../../../apps/desktop/src/lib/outbox/core'
import { fakeAccount, flush, memoryStorage, ACCOUNT } from '../store/chatOutboxHarness'

const MID = 'message-1'
const CHAT = 'chat-1'

type Row = { message_id: string; user_id: string; emoji: string }
const server = vi.hoisted(() => ({
  rows: [] as { message_id: string; user_id: string; emoji: string }[],
  /** Writes wait here until the test lets them reach the server. */
  writes: [] as { apply: () => void; resolve: () => void; reject: (error: unknown) => void }[],
  /** Reads answer what the server held when they began, once the test lets them land. */
  reads: [] as { rows: { message_id: string; user_id: string; emoji: string }[]; resolve: (rows: unknown[]) => void }[],
}))
const stored = vi.hoisted(() => ({ reactions: undefined as unknown, painted: [] as unknown[] }))
const box = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock('../../../../apps/desktop/src/lib/supabase', () => {
  const write = (apply: () => void) => ({
    throwOnError: () => new Promise<void>((resolve, reject) => { server.writes.push({ apply, resolve, reject }) }),
  })
  return {
    chatDb: {
      from: (table: string) => ({
        select: () => ({
          in: () => table !== 'message_reactions'
            ? Promise.resolve({ data: [], error: null })
            : new Promise((resolve) => {
              server.reads.push({ rows: server.rows.map((row) => ({ ...row })), resolve: (data) => resolve({ data, error: null }) })
            }),
        }),
        upsert: (row: Row) => write(() => {
          if (!server.rows.some((r) => r.user_id === row.user_id && r.emoji === row.emoji)) server.rows.push({ message_id: row.message_id, user_id: row.user_id, emoji: row.emoji })
        }),
        delete: () => {
          const match: Partial<Row> = {}
          const chain = {
            eq: (column: keyof Row, value: string) => { match[column] = value; return chain },
            ...write(() => { server.rows = server.rows.filter((r) => !(r.user_id === match.user_id && r.emoji === match.emoji)) }),
          }
          return chain
        },
      }),
    },
  }
})
vi.mock('../../../../apps/desktop/src/lib/messageIngest', () => ({
  // The store: an overlay patch replaces the stored row's reactions, and its publication paints them.
  ingestMessages: async (_account: string, batch: { writes: { type: string; id: string; fields: { reactions?: unknown } }[] }) => {
    for (const write of batch.writes) {
      if (write.type === 'patch' && write.id === MID && write.fields.reactions !== undefined) {
        stored.reactions = write.fields.reactions
        stored.painted.push(write.fields.reactions)
      }
    }
    return []
  },
  readMessagePage: async () => ({ rows: [] }),
}))
vi.mock('../../../../apps/desktop/src/lib/outbox', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  outbox: () => box.current,
}))

const { enqueueReaction, registerReactions, wishReaction } = await import('../../../../apps/desktop/src/lib/outbox/kinds/reaction')
const { loadMessageOverlays } = await import('../../../../apps/desktop/src/lib/chatMessageRevalidation')

const shown = (): MessageItem[] => [{ id: MID, chat_id: CHAT, reactions: stored.reactions } as MessageItem]
/** The chat store's toggle: the wish is painted (stored) and queued; its answer re-reads the counts. */
const tap = async (emoji: string) => {
  const wish = wishReaction(MID, emoji, shown())
  await enqueueReaction({ chatId: CHAT, messageId: MID, userId: ACCOUNT, emoji, on: wish.on }, wish.reactions)
  await flush()
}
/** Any reaction read of the message (a realtime event, a window revalidation): it begins now and lands later. */
const read = () => loadMessageOverlays([{ id: MID, chat_id: CHAT }], ACCOUNT)
const land = async (index = 0) => { const [r] = server.reads.splice(index, 1); r!.resolve(r!.rows); await flush() }
const answer = async (error?: unknown) => {
  const w = server.writes.shift()!
  if (error) w.reject(error); else { w.apply(); w.resolve() }
  await flush()
}
const thumbs = (count: number, mine: boolean): ReactionGroup[] => [{ emoji: '👍', count, my_reaction: mine }]
const showsThumb = (value: unknown) => Array.isArray(value) && value.some((group: ReactionGroup) => group.emoji === '👍')

let stop: () => void
beforeEach(async () => {
  stop?.()
  server.rows = []; server.writes = []; server.reads = []
  stored.reactions = []; stored.painted = []
  const outbox: Outbox = createOutbox({ storage: memoryStorage(), account: fakeAccount(), online: () => () => {} })
  box.current = outbox
  await outbox.loaded()
  // The store's answer hook: re-read the counts of the window (here: the one message).
  stop = registerReactions(() => { void read() })
})

describe('a reaction wish speaks for its message until it is answered (@@@reaction-read-order)', () => {
  it('a read landing before the removal is confirmed does not bring the removed 👍 back', async () => {
    server.rows = [{ message_id: MID, user_id: ACCOUNT, emoji: '👍' }]
    stored.reactions = thumbs(1, true)

    await tap('👍')
    expect(stored.painted).toEqual([[]])
    // Begun after the tap, answered before the delete reached the server: it still holds the 👍.
    void read()
    await land()
    expect(stored.painted).toEqual([[]])

    await answer()
    expect(server.rows).toEqual([])
    await land() // the read started by the answer
    expect(stored.painted).toEqual([[], []])
    expect(stored.painted.some(showsThumb)).toBe(false)
  })

  it('a read begun before the tap and landing after the confirmation does not either', async () => {
    server.rows = [{ message_id: MID, user_id: ACCOUNT, emoji: '👍' }]
    stored.reactions = thumbs(1, true)
    void read()
    await tap('👍')
    await answer()
    await land(0) // the old read
    expect(stored.painted.some(showsThumb)).toBe(false)
    await land()
    expect(stored.reactions).toEqual([])
  })

  it('quick taps add, remove, add: each tap is painted once, no read in between paints, and the end is 👍', async () => {
    await tap('👍') // add: its upsert is in flight
    void read()
    await tap('👍') // remove: merges into the same write
    void read()
    await tap('👍') // add again
    expect(stored.painted).toEqual([thumbs(1, true), [], thumbs(1, true)])

    await land(); await land() // reads of the server before any write landed: no 👍
    await answer() // the first upsert: a newer wish is still unanswered
    expect(stored.painted).toEqual([thumbs(1, true), [], thumbs(1, true)])
    await answer() // the last wish (add) is confirmed
    expect(server.rows.map((row) => row.emoji)).toEqual(['👍'])
    await land()
    expect(stored.painted).toEqual([thumbs(1, true), [], thumbs(1, true), thumbs(1, true)])
  })

  it('a refused write is answered too: the truth is read back', async () => {
    server.rows = [{ message_id: MID, user_id: ACCOUNT, emoji: '👍' }]
    stored.reactions = thumbs(1, true)
    await tap('👍')
    await answer(Object.assign(new Error('refused'), { code: '42501' }))
    await land()
    expect(stored.painted).toEqual([[], thumbs(1, true)])
  })
})
