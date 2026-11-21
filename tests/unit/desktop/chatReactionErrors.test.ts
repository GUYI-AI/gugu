// @vitest-environment jsdom
// Reactions as the outbox kind `reaction`: the person's wish (on/off), written idempotently; a refused write reaches the
// outbox as an error (never resolves as if written), and a double tap is one write of the last wish.
import { createClient } from '@supabase/supabase-js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageItem } from '@gugu/core/shared/types/chat'
const { from } = vi.hoisted(() => ({ from: vi.fn() }))
vi.mock('../../../apps/desktop/src/lib/supabase', () => ({
  chatDb: { from, rpc: vi.fn() }, identityDb: { from: vi.fn() }, dataClient: { storage: {} },
  getCurrentAuthUserId: vi.fn(), syncSchemaClientSession: vi.fn(),
}))
const { enqueueReaction, reactionOutboxKind, wishReaction, wishedReactions } = await import('../../../apps/desktop/src/lib/outbox/kinds/reaction')
const { createOutbox } = await import('../../../apps/desktop/src/lib/outbox/core')
const { fakeAccount, memoryStorage } = await import('./store/chatOutboxHarness')

function database(fail: boolean) {
  const fetch = vi.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify(fail ? { message: 'Reaction denied', code: '42501' } : []), {
    status: fail ? 403 : 201, headers: { 'content-type': 'application/json' },
  }))
  const client = createClient('http://127.0.0.1:54321', 'test-anon-key', { global: { fetch }, auth: { storageKey: `reaction-${Math.random()}`, persistSession: false, autoRefreshToken: false } }).schema('chat')
  from.mockImplementation((table: string) => client.from(table))
  return fetch
}
const wish = (on: boolean) => ({ chatId: 'chat', messageId: 'message', userId: 'user', emoji: '👍', on })
const item = (on: boolean) => ({ accountId: 'user', id: 'reaction:message:👍', kind: 'reaction', lane: 'reaction:message', order: 1, dependsOn: [], payload: wish(on), state: 'sending' as const, attempts: 0, rev: 0 })

beforeEach(() => { from.mockReset() })
afterEach(() => { vi.useRealTimers(); delete (globalThis as Record<string, unknown>).__GUGU_OUTBOX__ })

describe('reaction writes', () => {
  it.each([true, false])('surfaces a refused write (on: %s) instead of resolving successfully', async (on) => {
    const fetch = database(true)
    await expect(reactionOutboxKind(() => {}).send(item(on), new AbortController().signal)).rejects.toMatchObject({ message: 'Reaction denied' })
    expect(fetch).toHaveBeenCalledOnce()
  })

  it('adds with an upsert that ignores a duplicate, and removes by the unique key: both replay harmlessly', async () => {
    const fetch = database(false)
    const kind = reactionOutboxKind(() => {})
    await kind.send(item(true), new AbortController().signal)
    await kind.send(item(false), new AbortController().signal)
    const [add, remove] = fetch.mock.calls.map(([url, init]) => ({ url: String(url), method: init?.method, prefer: new Headers(init?.headers).get('prefer') }))
    expect(add).toMatchObject({ method: 'POST', prefer: expect.stringContaining('resolution=ignore-duplicates') })
    expect(add!.url).toContain('on_conflict=message_id%2Cuser_id%2Cemoji')
    expect(remove).toMatchObject({ method: 'DELETE' })
    expect(remove!.url).toContain('message_id=eq.message')
  })

  it('a double tap is one write of the last wish', async () => {
    vi.useFakeTimers()
    const fetch = database(false)
    const box = createOutbox({ storage: memoryStorage(), account: fakeAccount('user'), online: () => () => {} })
    ;(globalThis as Record<string, unknown>).__GUGU_OUTBOX__ = box
    const acked = vi.fn()
    box.register(reactionOutboxKind(acked))
    await box.loaded()
    await enqueueReaction(wish(true))
    await enqueueReaction(wish(false))
    await vi.advanceTimersByTimeAsync(10)
    // The first may already be in flight; what is confirmed last is the last wish.
    expect(fetch.mock.calls.at(-1)![1]?.method).toBe('DELETE')
    expect(acked).toHaveBeenLastCalledWith(wish(false))
    expect(box.items()).toEqual([])
    box.dispose()
  })
})

describe('the wish as the rows show it', () => {
  const row = (reactions: MessageItem['reactions']) => ({ id: 'message', reactions }) as MessageItem
  it('counts the person in or out once, whatever was shown', () => {
    expect(wishedReactions([], '👍', true)).toEqual([{ emoji: '👍', count: 1, my_reaction: true }])
    expect(wishedReactions([{ emoji: '👍', count: 2, my_reaction: false }], '👍', true)).toEqual([{ emoji: '👍', count: 3, my_reaction: true }])
    expect(wishedReactions([{ emoji: '👍', count: 3, my_reaction: true }], '👍', true)).toEqual([{ emoji: '👍', count: 3, my_reaction: true }])
    expect(wishedReactions([{ emoji: '👍', count: 1, my_reaction: true }], '👍', false)).toEqual([])
    expect(wishedReactions([{ emoji: '👍', count: 2, my_reaction: true }], '👍', false)).toEqual([{ emoji: '👍', count: 1, my_reaction: false }])
  })
  it('reads the toggle from the message as shown (main line or thread)', () => {
    const tapped = wishReaction('message', '👍', [], [row([{ emoji: '👍', count: 1, my_reaction: true }])])
    expect(tapped.on).toBe(false)
    expect(tapped.apply(row([{ emoji: '👍', count: 1, my_reaction: true }])).reactions).toEqual([])
    expect(wishReaction('message', '👍', [row([])]).on).toBe(true)
  })
})
