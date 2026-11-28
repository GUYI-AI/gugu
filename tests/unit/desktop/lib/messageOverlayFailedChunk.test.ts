import { describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({ failing: new Set<string>(), patches: [] as unknown[] }))
vi.mock('../../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from: (table: string) => ({ select: () => ({ in: async (_column: string, ids: string[]) =>
    db.failing.has(table) ? { data: null, error: { message: 'timeout' } }
      : { data: table === 'message_reactions' ? ids.map(id => ({ message_id: id, user_id: 'u', emoji: '👍' })) : [], error: null } }) }) },
}))
vi.mock('../../../../apps/desktop/src/lib/messageIngest', () => ({
  ingestMessages: async (_user: string, batch: { writes: unknown[] }) => { db.patches.push(...batch.writes) },
  readMessagePage: vi.fn(),
}))
import { loadMessageOverlays } from '../../../../apps/desktop/src/lib/chatMessageRevalidation'

describe('overlay facts that could not be read', () => {
  it('are left out, never folded to empty facts that would replace the stored ones', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const messages = [{ id: 'a', chat_id: 'c' }, { id: 'b', chat_id: 'c' }]
    expect((await loadMessageOverlays(messages, 'me')).get('a')?.reactions).toEqual([{ emoji: '👍', count: 1, my_reaction: false }])
    db.failing.add('message_reactions')
    db.patches.length = 0
    const overlays = await loadMessageOverlays(messages, 'me')
    expect(overlays.size).toBe(0)
    expect(db.patches).toEqual([{ type: 'patch', chatId: 'c', id: 'a', fields: {} }, { type: 'patch', chatId: 'c', id: 'b', fields: {} }])
  })
})
